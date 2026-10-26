import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
from quant_sdk import Bar, Dataset, Event, Instrument

START = 1792373400
SPLIT = START + 86400
SOURCE = '''from quant_sdk import Strategy
calls = 0
class Example(Strategy):
    def on_start(self, ctx):
        global calls
        calls += 1
        if calls != 1: raise ValueError('module leaked between trials')
        ctx.data.subscribe('TEST', 60)
        if ctx.params['size'] < 0: raise ValueError('invalid size')
    def on_bar(self, ctx, bar):
        n = ctx.state.get('n', 0)
        ctx.state['n'] = n + 1
        if n == 0: ctx.orders.target_position('TEST', ctx.params['size'])
        if n == 2: ctx.orders.target_position('TEST', 0)
'''


@unittest.skipUnless(importlib.util.find_spec('optuna'), 'Install worker requirements for real Optuna tests')
class OptimizationTest(unittest.TestCase):
    def setup_run(self, root, **options):
        root.mkdir(exist_ok=True)
        (root / 'strategy.py').write_text(SOURCE)
        events = []
        for day, prices, start in [('2026-10-19', [100, 100, 105, 110, 115], START),
                                   ('2026-10-20', [100, 100, 95, 90, 85], SPLIT)]:
            for i, price in enumerate(prices):
                bar = Bar('TEST', start + i * 60, start + (i + 1) * 60, day, 60, price, price + 1, price - 1, price, 1000)
                events.append(Event(f'{day}:{i}', start + (i + 1) * 60, bar))
        Dataset([Instrument('TEST', 'future', 1, multiplier=1, margin_rate=1)], events).save(root / 'dataset.json')
        config = {'start': START, 'end': SPLIT + 300, 'initial_cash': 10000, 'slippage_ticks': 0,
                  'parameters': {'size': 1, 'fixed': 'preserved'},
                  'optimization': {'search_space': {'size': {'type': 'categorical', 'choices': [0, -1, 1, 2]}},
                                   'metric': 'total_return', 'n_trials': 12, 'timeout_seconds': 30,
                                   'seed': 42, 'min_trades': 1, 'validation_start': SPLIT, **options}}
        (root / 'config.json').write_text(json.dumps(config))

    def command(self, root):
        return [sys.executable, '-B', str(ROOT / 'worker/strategy_optimize.py'), str(ROOT / 'sdk'), str(root)]

    def run_search(self, root):
        process = subprocess.run(self.command(root), capture_output=True, text=True, timeout=45)
        self.assertEqual(process.returncode, 0, process.stderr)
        return json.loads((root / 'optimization.json').read_text())

    def test_real_tpe_isolation_best_artifact_validation_and_seed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.setup_run(root)
            report = self.run_search(root)
            self.assertEqual(report['status'], 'completed', report)
            self.assertEqual(report['best_parameters']['size'], 2)
            self.assertEqual(report['best_parameters']['fixed'], 'preserved')
            self.assertGreater(report['best_value'], 0)
            self.assertLess(report['validation']['metrics']['total_return'], 0)
            self.assertEqual(report['validation']['status'], 'succeeded')
            self.assertEqual({t['state'] for t in report['trials']}, {'failed', 'pruned', 'complete'})
            result = json.loads((root / 'result.json').read_text())
            manifest = json.loads((root / 'artifacts' / result['run_id'] / 'manifest.json').read_text())
            self.assertEqual(result['metrics']['total_return'], report['best_value'])
            self.assertEqual(manifest['params'], report['best_parameters'])
            self.assertTrue(all(point['time'] < SPLIT for point in result['equity_curve']))
            validation = json.loads((root / 'validation.json').read_text())
            self.assertTrue(all(point['time'] >= SPLIT for point in validation['result']['equity_curve']))
            self.assertEqual(validation['manifest']['config']['initial_cash'], 10000)
            self.assertFalse(list(root.glob('trial-*')))
            self.assertEqual(len(list((root / 'artifacts').iterdir())), 1)
            # Change only held-out prices. Sampling and the selected training score must stay identical.
            data = json.loads((root / 'dataset.json').read_text())
            for event in data['events']:
                if event['available_at'] >= SPLIT:
                    for key in ('open', 'high', 'low', 'close'):
                        event['payload'][key] *= 10
            (root / 'dataset.json').write_text(json.dumps(data))
            second = self.run_search(root)
            self.assertEqual([t['parameters'] for t in report['trials']], [t['parameters'] for t in second['trials']])
            self.assertEqual(second['best_value'], report['best_value'])
            self.assertEqual(second['best_parameters'], report['best_parameters'])

    def test_no_trades_undefined_metric_and_strategy_error_are_not_optima(self):
        for size, metric, state in [(0, 'total_return', 'pruned'), (1, 'sharpe', 'pruned'), (-1, 'total_return', 'failed')]:
            with self.subTest(size=size), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                self.setup_run(root, n_trials=2, metric=metric, search_space={'size': {'type': 'int', 'low': size, 'high': size}})
                report = self.run_search(root)
                self.assertEqual(report['status'], 'failed')
                self.assertIsNone(report['best_trial'])
                self.assertEqual({t['state'] for t in report['trials']}, {state})
                self.assertFalse((root / 'result.json').exists())

    def test_drawdown_minimizes_and_float_search_works(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.setup_run(root, metric='max_drawdown', validation_start=None, search_space={
                'size': {'type': 'int', 'low': 1, 'high': 4},
                'risk': {'type': 'float', 'low': 0.01, 'high': 0.1, 'log': True},
            })
            report = self.run_search(root)
            self.assertEqual(report['status'], 'completed')
            self.assertEqual(report['direction'], 'minimize')
            self.assertEqual(report['best_value'], min(t['value'] for t in report['trials'] if t['state'] == 'complete'))
            self.assertTrue(all(0.01 <= t['parameters']['risk'] <= 0.1 for t in report['trials']))

    def test_empty_holdout_is_a_validation_failure_with_training_result_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.setup_run(root, n_trials=1, search_space={'size': {'type': 'int', 'low': 1, 'high': 1}})
            data = json.loads((root / 'dataset.json').read_text())
            data['events'] = [event for event in data['events'] if event['available_at'] < SPLIT]
            (root / 'dataset.json').write_text(json.dumps(data))
            report = self.run_search(root)
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(report['validation']['status'], 'failed')
            self.assertIn('没有可评估的行情', report['validation']['message'])
            self.assertTrue((root / 'result.json').exists())

    def test_hung_trial_obeys_search_deadline(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.setup_run(root, timeout_seconds=1)
            (root / 'strategy.py').write_text('import time\ntime.sleep(30)\n' + SOURCE)
            started = time.monotonic()
            report = self.run_search(root)
            self.assertLess(time.monotonic() - started, 8)
            self.assertEqual(report['status'], 'failed')
            self.assertIn('超时', report['trials'][0]['message'])

    def test_cancellation_preserves_finished_trials_and_best_result(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.setup_run(root, search_space={'size': {'type': 'int', 'low': 1, 'high': 1}})
            (root / 'strategy.py').write_text("from pathlib import Path\nimport time\nif Path(__file__).parent.name != 'trial-0': time.sleep(30)\n" + SOURCE)
            child = subprocess.Popen(self.command(root), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
            try:
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    path = root / 'optimization.json'
                    report = json.loads(path.read_text()) if path.exists() else {}
                    if report.get('trials') and '2/' in report['message']:
                        break
                    time.sleep(0.05)
                else:
                    self.fail('second trial did not start')
                os.killpg(child.pid, signal.SIGTERM)
                _, error = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, error)
                report = json.loads((root / 'optimization.json').read_text())
                self.assertEqual(report['status'], 'cancelled')
                self.assertEqual(report['best_trial'], 0)
                self.assertTrue((root / 'result.json').exists())
                self.assertEqual(report['trials'][-1]['state'], 'cancelled')
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.communicate()


if __name__ == '__main__':
    unittest.main()
