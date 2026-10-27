"""Parity against the actual chart, causality, filtering and SDK execution."""
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

PLUGIN = Path(__file__).resolve().parents[1]
ROOT = PLUGIN.parents[1]
sys.path.insert(0, str(PLUGIN / 'sdk'))
from quant_sdk import Bar, Dataset, Event, Instrument, Roll, RunConfig, backtest

spec = importlib.util.spec_from_file_location('logistic_example', PLUGIN / 'sdk/examples/logistic_sr_rsi_volume.py')
strategy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = strategy
spec.loader.exec_module(strategy)
DEFAULTS = json.loads((PLUGIN / 'sdk/examples/logistic_sr_rsi_volume.parameters.json').read_text())
SYMBOL = 'KQ.m@CFFEX.IM'
START = datetime(2026, 10, 26, 9, 30, tzinfo=ZoneInfo('Asia/Shanghai')).timestamp()
ROWS = [[10, 11, 9, 10], [11, 14, 11, 12], [11, 12, 10, 11], [12, 13, 11, 12],
        [13, 15, 12, 13], [13, 15, 12, 13], [13, 15, 12, 13], [13, 15, 12, 13],
        [13, 15, 12, 13], [14, 16, 9, 14], [9, 13, 8, 9]]


def bars(rows, volume=100):
    return [Bar(SYMBOL, START + i * 60, START + (i + 1) * 60, '2026-10-26', 60, *row, volume)
            for i, row in enumerate(rows)]


def replay(data, params, restore=False):
    state, events = {}, []
    for i, bar in enumerate(data):
        snapshot = strategy.observe(state, bar, params)
        events.extend([e['index'], e['type'], e['level']['startIndex'], e['level']['isSupport']]
                      for e in snapshot['events'])
        if restore and i % 13 == 0:
            state = json.loads(json.dumps(state, allow_nan=False))
    return state, events


class LogisticStrategyTest(unittest.TestCase):
    def setUp(self):
        self.params = {**DEFAULTS, 'duration': 60, 'pivot_length': 1,
                       'probability_threshold': .001, 'rsi_filter': False, 'volume_filter': False}

    def test_chart_parity_and_json_restore(self):
        # Compare two independently implemented production paths, including
        # future training labels that continue updating rejected levels.
        generated = []
        for i in range(600):
            op = 100 + 8 * math.sin(i / 5) + 3 * math.cos(i / 17)
            close = op + math.sin(i * 1.7)
            generated.append([op, max(op, close) + 1 + abs(math.cos(i)),
                              min(op, close) - 1 - abs(math.sin(i)), close])
        for rows, length, threshold in ((ROWS, 1, .001), (generated, 5, .7), (generated, 14, .7)):
            data = bars(rows)
            p = {**self.params, 'pivot_length': length, 'probability_threshold': threshold}
            state, events = replay(data, p)
            self.assertEqual((state, events), replay(data, p, restore=True))
            script = """
import fs from 'node:fs';
import { calculateLogisticSr } from './plugins/vibe-quant/web/indicators/main/logistic-sr/engine.ts';
import { logisticSrSettings } from './plugins/vibe-quant/web/indicators/main/logistic-sr/settings.ts';
const v = JSON.parse(fs.readFileSync(0, 'utf8'));
const r = calculateLogisticSr(v.bars, logisticSrSettings(v.settings));
process.stdout.write(JSON.stringify({levels:r.levels,events:r.events.map(e=>[e.index,e.type,e.level.startIndex,e.level.isSupport])}));
"""
            payload = {'bars': [dict(time=b.time, open=b.open, high=b.high, low=b.low, close=b.close) for b in data],
                       'settings': {'pivotLength': length, 'targetRespects': p['target_respects'], 'probabilityThreshold': threshold}}
            result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script],
                                    input=json.dumps(payload), text=True, capture_output=True, cwd=ROOT, check=True)
            expected = json.loads(result.stdout)
            self.assertEqual(events, expected['events'])
            self.assertEqual(len(state['levels']), len(expected['levels']))
            for actual, chart in zip(state['levels'], expected['levels']):
                score = actual['detectedPrediction']
                self.assertAlmostEqual(score, chart['detectedPrediction'], places=12)
                self.assertEqual({k: v for k, v in actual.items() if k != 'detectedPrediction'},
                                 {k: v for k, v in chart.items() if k != 'detectedPrediction'})

    def test_confirmation_and_future_suffix_never_change_earlier_signals(self):
        data = bars(ROWS)
        self.assertEqual(replay(data[:2], self.params)[0]['levels'], [])
        full, events = replay(data, self.params)
        self.assertEqual(full['levels'][0]['confirmedIndex'], 2)
        for stop in range(1, len(data)):
            prefix, early = replay(data[:stop], self.params)
            self.assertEqual(early, [e for e in events if e[0] < stop])
            for level in prefix['levels']:
                found = next(x for x in full['levels'] if (x['startIndex'], x['isSupport']) ==
                             (level['startIndex'], level['isSupport']))
                self.assertEqual(level['detectedPrediction'], found['detectedPrediction'])
        # Equal right-hand extremes delay confirmation to the last occurrence.
        tied = bars([[2, 3, 1, 2], [3, 5, 2, 3], [3, 5, 2, 3], [2, 3, 1, 2]])
        self.assertEqual(replay(tied[:3], self.params)[0]['levels'], [])
        self.assertEqual(replay(tied, self.params)[0]['levels'][0]['startIndex'], 2)

    def test_volume_excludes_current_bar_and_duplicate_candles(self):
        p = {**self.params, 'volume_length': 3, 'volume_filter': True}
        state = {}
        for bar in bars(ROWS[:3], volume=100):
            strategy.observe(state, bar, p)
        bar = bars(ROWS, volume=120)[3]
        snapshot = strategy.observe(state, bar, p)
        self.assertEqual(snapshot['mean_volume'], 100)
        self.assertTrue(strategy.volume_allows(120, snapshot, p))
        self.assertFalse(strategy.volume_allows(119, snapshot, p))
        self.assertIsNone(strategy.observe(state, bar, p))
        self.assertEqual(state['count'], 4)
        self.assertFalse(strategy.volume_allows(100, {**snapshot, 'mean_volume': 0}, p))

    def test_rsi_direction_threshold_and_warmup(self):
        p = {**self.params, 'rsi_filter': True}
        snapshot = {'rsi': 45, 'previous_rsi': 43, 'rsi_ready': True}
        self.assertTrue(strategy.rsi_allows(1, snapshot, p))
        self.assertFalse(strategy.rsi_allows(-1, snapshot, p))
        self.assertFalse(strategy.rsi_allows(1, {**snapshot, 'previous_rsi': 47}, p))
        self.assertFalse(strategy.rsi_allows(1, {**snapshot, 'rsi': 51}, p))
        self.assertFalse(strategy.rsi_allows(1, {**snapshot, 'rsi_ready': False}, p))
        self.assertTrue(strategy.rsi_allows(-1, {**snapshot, 'rsi': 55, 'previous_rsi': 57}, p))

    def run_strategy(self, data, params=None, start=None):
        with tempfile.TemporaryDirectory() as directory:
            instrument = Instrument(SYMBOL, 'future', .2, multiplier=200, margin_rate=.12)
            return backtest.run(strategy.LogisticSRRSIVolume(), Dataset([instrument], [Event(f'{b.duration}:{b.time}', b.end_time, b) for b in data]),
                                params=params or self.params, config=RunConfig(initial_cash=1_000_000, start=start), output_dir=directory)

    def test_next_bar_fill_bracket_and_both_filters_block_entry(self):
        data = bars(ROWS[:6] + [[13, 30, 1, 13]])
        result = self.run_strategy(data, {**self.params, 'max_entries_per_day': 1})
        self.assertEqual(result['status'], 'succeeded', result['message'])
        signals = [s for s in result['signals'] if s['kind'] == 'logistic_sr_retest']
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]['time'], data[4].end_time)
        self.assertEqual(result['fills'][0]['time'], data[5].time)
        self.assertEqual(result['fills'][0]['price'], data[5].open)
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['exit_reason'], 'stop_loss')
        self.assertLess(result['risk_levels'][0]['time'], data[6].end_time)
        for override in ({'rsi_filter': True}, {'volume_filter': True, 'volume_length': 3}):
            filtered = self.run_strategy(data, {**self.params, **override})
            self.assertEqual(filtered['status'], 'succeeded', filtered['message'])
            self.assertEqual(filtered['fills'], [])

    def test_warmup_and_deadline(self):
        data = bars(ROWS[:6])
        late = Bar(SYMBOL, START + 314 * 60, START + 315 * 60, '2026-10-26', 60, 13, 14, 12, 13, 100)
        after = Bar(SYMBOL, late.end_time, late.end_time + 60, late.trading_day, 60, 13, 14, 12, 13, 100)
        result = self.run_strategy(data + [late, after], start=data[4].end_time)
        self.assertEqual(result['status'], 'succeeded', result['message'])
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['exit_reason'], 'lr_sr_session_close')
        self.assertEqual(result['trades'][0]['exit_time'], late.end_time)

    def test_five_minute_signals_use_next_one_minute_execution(self):
        data = []
        for i, row in enumerate(ROWS[:6] + [[13, 30, 1, 13]]):
            begin = START + i * 300
            for minute in range(5):
                data.append(Bar(SYMBOL, begin + minute * 60, begin + (minute + 1) * 60,
                                '2026-10-26', 60, *row, 100))
            data.append(Bar(SYMBOL, begin, begin + 300, '2026-10-26', 300, *row, 500))
        result = self.run_strategy(data, {**self.params, 'duration': 300, 'max_entries_per_day': 1})
        self.assertEqual(result['status'], 'succeeded', result['message'])
        signals = [s for s in result['signals'] if s['kind'] == 'logistic_sr_retest']
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0]['time'], START + 25 * 60)
        self.assertEqual(result['fills'][0]['time'], START + 25 * 60)
        self.assertEqual(len(result['trades']), 1)
        self.assertEqual(result['trades'][0]['exit_bar_time'], START + 30 * 60)

    def test_actual_contract_uses_synchronous_basis_and_missing_bar_blocks_entry(self):
        actual = 'CFFEX.IM2612'
        for include_actual in (True, False):
            events = [Event('roll', START, Roll(SYMBOL, actual, START, '2026-10-26'))]
            for bar in bars(ROWS[:6]):
                if include_actual:
                    real = Bar(actual, bar.time, bar.end_time, bar.trading_day, 60,
                               bar.open + 100, bar.high + 100, bar.low + 100, bar.close + 100, bar.volume)
                    events.append(Event(f'actual:{bar.time}', real.end_time, real))
                events.append(Event(f'main:{bar.time}', bar.end_time, bar))
            with tempfile.TemporaryDirectory() as directory:
                result = backtest.run(strategy.LogisticSRRSIVolume(), Dataset([
                    Instrument(SYMBOL, 'continuous', .2),
                    Instrument(actual, 'future', .2, multiplier=200, margin_rate=.12)], events),
                    params=self.params, config=RunConfig(initial_cash=1_000_000), output_dir=directory)
            self.assertEqual(result['status'], 'succeeded', result['message'])
            if include_actual:
                synthetic = self.run_strategy(bars(ROWS[:6]))
                self.assertEqual(result['fills'][0]['symbol'], actual)
                self.assertAlmostEqual(result['risk_levels'][0]['stop_loss'],
                                       synthetic['risk_levels'][0]['stop_loss'] + 100)
            else:
                self.assertEqual(result['orders'], [])


if __name__ == '__main__':
    unittest.main()
