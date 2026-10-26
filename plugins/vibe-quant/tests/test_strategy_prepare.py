import importlib.util
import json
from datetime import datetime
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
from quant_sdk import Bar, Dataset, RunConfig, Strategy, backtest

spec = importlib.util.spec_from_file_location('strategy_prepare', ROOT / 'worker/strategy_prepare.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MAIN = 'KQ.m@CFFEX.IM'


class PrepareTest(unittest.TestCase):
    def fixture(self, model):
        start = 1792373400  # 2026-10-19 09:30 Asia/Shanghai
        return {
            'engine': 'tqsdk', 'mappings': {},
            'instruments': {MAIN: {'symbol': MAIN, 'kind': 'continuous', 'priceTick': .2}},
            'config': {
                'symbol': MAIN, 'benchmark_symbol': MAIN, 'duration': 60,
                'execution_model': model, 'start': start, 'end': start + 120,
                'calendar': {'2026-10-19': True},
                'rules': {'multiplier': 200, 'margin_rate': .12, 'lot_size': 1, 't_plus_one': False,
                          'fees': {'per_unit': 20}},
            },
            'bars': [{'symbol': MAIN, 'duration': 60, 'time': start + i * 60,
                      'open': 6000, 'high': 6010, 'low': 5990, 'close': 6005, 'volume': 1000}
                     for i in range(2)],
        }

    def test_proxy_keeps_raw_catalog_and_manifest_identifies_approximation(self):
        raw = self.fixture('continuous_price')
        dataset = module.prepare(raw)
        self.assertEqual(raw['instruments'][MAIN]['kind'], 'continuous')
        self.assertEqual(len(dataset.instruments), 1)
        item = dataset.instruments[0]
        self.assertEqual((item.symbol, item.kind, item.tradable), (MAIN, 'future', True))
        self.assertEqual(item.fees.per_unit, 20)
        self.assertEqual(len(dataset.events), 2)
        self.assertTrue(all(isinstance(e.payload, Bar) and e.payload.symbol == MAIN for e in dataset.events))
        with tempfile.TemporaryDirectory() as directory:
            result = backtest.run(Strategy(), dataset, config=RunConfig(start=raw['config']['start']), output_dir=directory)
            self.assertEqual(result['status'], 'succeeded', result['message'])
            manifest = json.loads((Path(directory) / result['run_id'] / 'manifest.json').read_text())
            self.assertEqual(manifest['execution_model'], 'continuous_price')
            self.assertEqual(manifest['simulated_execution_symbol'], MAIN)

    def test_actual_contract_mode_still_requires_mapping(self):
        with self.assertRaises(KeyError):
            module.prepare(self.fixture('actual_contract'))

    def test_expanded_window_keeps_available_bars_and_requested_bounds(self):
        raw = self.fixture('continuous_price')
        expected = module.prepare(raw).events
        raw['config']['start'] -= 366 * 86400
        raw['config']['end'] += 366 * 86400
        dataset = module.prepare(raw)
        self.assertEqual(dataset.events, expected)
        self.assertEqual(dataset.metadata['start'], raw['config']['start'])
        self.assertEqual(dataset.metadata['end'], raw['config']['end'])

    def test_default_calendar_does_not_require_dates_without_data(self):
        raw = self.fixture('continuous_price')
        raw['config'].pop('calendar')
        raw['config']['start'] -= 2 * 366 * 86400
        raw['config']['end'] += 2 * 366 * 86400
        def is_holiday(day):
            if day.isoformat() != '2026-10-19':
                raise NotImplementedError('Holiday data unavailable')
            return False
        with patch.dict(sys.modules, {'chinese_calendar': SimpleNamespace(is_holiday=is_holiday)}):
            dataset = module.prepare(raw)
        self.assertEqual(len(dataset.events), 2)
        self.assertEqual(dataset.metadata['calendar']['days'], {'2026-10-19': True})

    def test_default_calendar_resolves_friday_night_to_monday(self):
        raw = self.fixture('continuous_price')
        raw['config'].pop('calendar')
        start = datetime.fromisoformat('2026-10-23T21:00:00+08:00').timestamp()
        raw['config'].update(start=start, end=start + 120)
        for i, bar in enumerate(raw['bars']):
            bar['time'] = start + i * 60
        with patch.dict(sys.modules, {'chinese_calendar': SimpleNamespace(is_holiday=lambda day: False)}):
            dataset = module.prepare(raw)
        self.assertEqual({event.payload.trading_day for event in dataset.events}, {'2026-10-26'})
        self.assertEqual(dataset.metadata['calendar']['days'], {
            '2026-10-24': False, '2026-10-25': False, '2026-10-26': True,
        })

    def test_default_calendar_includes_observed_contract_mapping_before_bars(self):
        raw = self.fixture('actual_contract')
        raw['config'].pop('calendar')
        raw['config']['start'] = datetime.fromisoformat('2026-10-16T09:30:00+08:00').timestamp()
        contract = 'CFFEX.IM2611'
        raw['instruments'][contract] = {'symbol': contract, 'kind': 'future', 'priceTick': .2}
        raw['mappings'][MAIN] = [{'time': raw['config']['start'], 'underlying': contract}]
        raw['bars'] += [{**bar, 'symbol': contract} for bar in raw['bars']]
        with patch.dict(sys.modules, {'chinese_calendar': SimpleNamespace(is_holiday=lambda day: False)}):
            dataset = module.prepare(raw)
        self.assertEqual(len(dataset.events), 5)
        self.assertEqual(dataset.metadata['calendar']['days'], {'2026-10-16': True, '2026-10-19': True})

    def test_unknown_calendar_date_with_actual_data_still_fails(self):
        raw = self.fixture('continuous_price')
        raw['config'].pop('calendar')
        def is_holiday(day):
            raise NotImplementedError('Holiday data unavailable')
        with patch.dict(sys.modules, {'chinese_calendar': SimpleNamespace(is_holiday=is_holiday)}):
            with self.assertRaisesRegex(NotImplementedError, 'Holiday data unavailable'):
                module.prepare(raw)

    def test_empty_requested_window_has_a_specific_data_error(self):
        raw = self.fixture('continuous_price')
        raw['config'].pop('calendar')
        raw['config']['start'] = raw['config']['end']
        raw['config']['end'] += 86400
        with self.assertRaisesRegex(ValueError, '所选回测区间内没有可用行情'):
            module.prepare(raw)

    def test_fee_modes_survive_preparation_and_saved_dataset(self):
        for mode in ('fixed', 'rate', 'combined'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                raw = self.fixture('continuous_price')
                raw['config']['rules']['fees'].update(mode=mode, rate=.001, close_today_per_unit=0)
                dataset = module.prepare(raw)
                item = dataset.instruments[0]
                self.assertEqual(item.fees.mode, mode)
                self.assertEqual(item.fees.per_unit, 20)
                self.assertEqual(item.fees.close_today_per_unit, 0)
                path = Path(directory) / 'dataset.json'
                dataset.save(path)
                loaded = Dataset.load(path)
                self.assertEqual(loaded.instruments[0].fees, item.fees)
                self.assertEqual(loaded.fingerprint, dataset.fingerprint)

    def test_invalid_proxy_catalog_is_rejected(self):
        raw = self.fixture('continuous_price')
        raw['instruments'][MAIN]['kind'] = 'future'
        with self.assertRaisesRegex(ValueError, 'requires a main continuous series'):
            module.prepare(raw)


if __name__ == '__main__':
    unittest.main()
