import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
from quant_sdk import Bar, RunConfig, Strategy, backtest

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

    def test_invalid_proxy_catalog_is_rejected(self):
        raw = self.fixture('continuous_price')
        raw['instruments'][MAIN]['kind'] = 'future'
        with self.assertRaisesRegex(ValueError, 'requires a main continuous series'):
            module.prepare(raw)


if __name__ == '__main__':
    unittest.main()
