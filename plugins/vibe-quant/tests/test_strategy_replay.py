import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
sys.path.insert(0, str(ROOT / 'worker'))
from strategy_replay import replay
from test_option_execution import fixture

START = 1792373400
SOURCE = '''from quant_sdk import Strategy
class Protected(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], ctx.params['duration'])
    def on_bar(self, ctx, bar):
        assert bar.end_time <= ctx.now
        assert all(value.end_time <= ctx.now for value in ctx.data.history(bar.symbol, bar.duration, 1000))
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        if n == 0:
            ctx.state['entry'] = ctx.orders.target_position(bar.symbol, 1, reason='test entry')
            ctx.set_risk_levels(bar.symbol, entry_id=ctx.state['entry'], stop_loss=90, take_profit=120)
        elif n == 2:
            ctx.set_risk_levels(bar.symbol, entry_id=ctx.state['entry'], stop_loss=95, take_profit=120,
                                stop_loss_note='成本保护', take_profit_note='达到目标', stop_loss_pnl=0)
'''


def raw(duration=60):
    symbol = 'SSE.000852'
    return {'engine': 'tqsdk', 'mappings': {},
        'instruments': {symbol: {'symbol': symbol, 'kind': 'stock', 'priceTick': 1}},
        'config': {'symbol': symbol, 'benchmark_symbol': symbol, 'duration': duration,
                   'execution_model': 'points', 'initial_cash': 1, 'point_cost': 0,
                   'parameters': {}, 'start': START, 'end': START + 360,
                   'calendar': {'2026-10-19': True}, 'rules': {}},
        'bars': [{'symbol': symbol, 'duration': 60, 'time': START + i * 60,
                  'open': 100, 'high': 101, 'low': 94 if i == 3 else 99, 'close': 100, 'volume': 1000}
                 for i in range(6)]}


def run(directory, snapshot, indices, strategy=SOURCE):
    (directory / 'strategy.py').write_text(strategy)
    (directory / 'market.json').write_text(json.dumps(snapshot))
    (directory / 'request.json').write_text(json.dumps({'monitor_id': 'monitor', 'times': [START + i * 60 for i in indices]}))
    replay(directory)
    result = json.loads((directory / 'result.json').read_text())
    (directory / 'checkpoint.next.json').replace(directory / 'checkpoint.json')
    return result['frames']


class StrategyReplayTest(unittest.TestCase):
    def test_frames_retain_causal_positions_protection_and_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            frames = run(Path(directory), raw(), [1, 2, 3, 4, 5, 6])
            self.assertEqual([signal['type'] for signal in frames[0]['signals']], ['entry'])
            self.assertEqual(frames[0]['positions'], [])  # next-bar-open fill
            self.assertEqual(frames[1]['positions'][0]['quantity'], 1)
            self.assertEqual(frames[1]['overlay']['levels'][0]['stop_loss'], 90)
            self.assertEqual(frames[2]['overlay']['levels'][0]['stop_loss'], 95)
            self.assertEqual(frames[2]['overlay']['levels'][0]['stop_loss_note'], '成本保护')
            self.assertEqual(frames[2]['overlay']['levels'][0]['take_profit_note'], '达到目标')
            self.assertEqual(frames[2]['overlay']['levels'][0]['stop_loss_pnl'], 0)
            self.assertEqual(frames[3]['positions'], [])
            self.assertEqual(frames[3]['overlay']['levels'], [])
            self.assertEqual([signal['type'] for signal in frames[3]['signals']], ['exit'])
            self.assertEqual(frames[3]['trades'][0]['exit_reason'], 'stop_loss')
            self.assertEqual(frames[3]['signals'][0]['exit_note'], '成本保护')
            self.assertEqual(frames[3]['signals'][0]['pnl'], {'value': 0, 'unit': 'points', 'basis': 'override'})
            self.assertEqual(frames[3]['trades'][0]['net_pnl'], 0)
            self.assertEqual(frames[3]['trades'][0]['exit_note'], '成本保护')
            self.assertEqual(frames[3]['trades'][0]['exit_price'], 95)
            self.assertEqual(frames[3]['summary']['metrics']['total_points'], 0)
            self.assertEqual(frames[3]['summary']['metrics']['trade_count'], 1)
            # Rewinding is an exact lookup; later fills cannot mutate saved frames.
            self.assertEqual(frames[1]['positions'][0]['status'], 'open')
            self.assertEqual([level['stop_loss'] for level in frames[1]['positions'][0]['risk_levels']], [90])
            self.assertEqual(frames[1]['trades'], [])

    def test_extending_checkpoint_matches_uninterrupted_run(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            expected = run(Path(a), raw(), [1, 2, 3, 4, 5, 6])
            first = run(Path(b), raw(), [1, 2, 3])
            second = run(Path(b), raw(), [4, 5, 6])
            self.assertEqual(first + second, expected)

    def test_empty_option_frames_and_resume_with_cash_index_and_chain(self):
        snap, ticker = fixture(main=True)
        config = snap['config']
        config.update(execution_model='actual_contract', initial_cash=100000, parameters={})
        main = config['symbol']
        snap['mappings'][main][0]['time'] = START+60
        # The last reference for the first minute is missing. Quotes appear in
        # a later frame and the original pending signal is never replayed.
        snap['bars'] = [b for b in snap['bars'] if b['symbol'] != 'SSE.000852' or b['time'] >= START+120]
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as baseline:
            first = run(Path(directory), snap, [1,2])
            self.assertTrue(all(not frame['signals'] and not frame['summary']['equity_curve'] for frame in first))
            rest = run(Path(directory), snap, [3,4,5])
            expected = run(Path(baseline), snap, [1,2,3,4,5])
            self.assertEqual(first+rest, expected)
            self.assertEqual(rest[1]['signals'][0]['symbol'], ticker.replace('5000','4995'))
        snap['bars'].clear()
        snap['mappings'][main].clear()
        with tempfile.TemporaryDirectory() as directory:
            frames = run(Path(directory), snap, [1,2])
            self.assertTrue(all(not f['positions'] and not f['summary']['equity_curve'] for f in frames))

    def test_missing_held_contract_preserves_cost_and_resumes_on_new_chain_after_expiry(self):
        snap, ticker = fixture(main=True)
        cfg = snap['config']
        cfg.update(execution_model='actual_contract', initial_cash=100000, parameters={}, end=START+86400+180)
        cfg['calendar']['2026-10-20'] = True
        main, future, later = cfg['symbol'], 'CFFEX.IM2611', 'CFFEX.IM2612'
        for meta in snap['instruments'].values():
            if meta['kind'] == 'option':
                meta['expiryDay'] = '2026-10-19'
        new_option = ticker.replace('2611','2612')
        for old, new in [(future,later), (ticker,new_option)]:
            snap['instruments'][new] = {**snap['instruments'][old], 'symbol':new}
        snap['instruments'][new_option]['expiryDay'] = '2026-12-18'
        snap['mappings'][main].append(dict(time=START+86400, underlying=later))
        snap['bars'] += [{**b, 'symbol':{ticker:new_option, future:later}.get(b['symbol'], b['symbol']),
                         'time':b['time']+86400} for b in snap['bars']
                         if b['symbol'] in (ticker, future, main, 'SSE.000852') and b['time'] < START+180]
        snap['bars'] = [b for b in snap['bars'] if b['symbol'] != ticker or b['time'] < START+120]
        strategy = """from quant_sdk import Strategy
class Hold(Strategy):
    def on_start(self, ctx): ctx.data.subscribe(ctx.params['symbol'],60)
    def on_bar(self, ctx, bar):
        if not ctx.position(bar.symbol): ctx.orders.target_position(bar.symbol,1)
"""
        with tempfile.TemporaryDirectory() as directory:
            frames = run(Path(directory), snap, [1,2,3,4,1441,1442], strategy)
        self.assertEqual(frames[1]['signals'][0]['symbol'], ticker)
        self.assertEqual(frames[1]['summary']['equity_curve'], frames[3]['summary']['equity_curve'])
        self.assertEqual(frames[-1]['signals'][0]['symbol'], new_option)
        self.assertEqual(frames[-1]['summary']['metrics']['trade_count'], 0)
        old = next(p for p in frames[-1]['positions'] if p['symbol'] == ticker)
        self.assertEqual(old['observed_until'], START+120)
        self.assertIsNone(old['exit_price'])

    def test_five_minute_strategy_waits_for_closed_bar(self):
        snapshot = raw(300)
        snapshot['bars'].append({**snapshot['bars'][0], 'duration': 300, 'low': 94})
        with tempfile.TemporaryDirectory() as directory:
            frames = run(Path(directory), snapshot, [1, 2, 3, 4, 5, 6])
            self.assertTrue(all(not frame['signals'] for frame in frames[:4]))
            self.assertEqual([signal['type'] for signal in frames[4]['signals']], ['entry'])
            self.assertEqual(frames[5]['positions'][0]['quantity'], 1)


if __name__ == '__main__':
    unittest.main()
