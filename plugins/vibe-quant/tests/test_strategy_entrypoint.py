import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tempfile
from types import ModuleType
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sdk'))
from quant_sdk import Bar, Dataset, Event, Instrument, Strategy

spec = importlib.util.spec_from_file_location('strategy_entrypoint', ROOT / 'worker/strategy_entrypoint.py')
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)


class EntrypointTest(unittest.TestCase):
    def module(self, source):
        module = ModuleType('user_strategy')
        exec('from quant_sdk import Strategy\n' + source, module.__dict__)
        return module

    def test_single_class_and_alias_are_automatic(self):
        module = self.module('class Orb(Strategy): pass\nAlias = Orb')
        self.assertIs(resolver.resolve_strategy(module, Strategy), module.Orb)

    def test_local_parent_and_abstract_base_do_not_create_ambiguity(self):
        for source in (
            'class Parent(Strategy): pass\nclass Child(Parent): pass',
            'from abc import ABC, abstractmethod\nclass Parent(Strategy, ABC):\n @abstractmethod\n def choose(self): pass\nclass Child(Parent):\n def choose(self): pass',
        ):
            module = self.module(source)
            self.assertIs(resolver.resolve_strategy(module, Strategy), module.Child)

    def test_independent_classes_require_separate_scripts(self):
        module = self.module('class Long(Strategy): pass\nclass Short(Strategy): pass')
        with self.assertRaisesRegex(ValueError, '多个独立的 Strategy 子类.*Long.*Short.*拆分'):
            resolver.resolve_strategy(module, Strategy)

    def test_imported_classes_are_not_automatically_selected(self):
        module = self.module('class Local(Strategy): pass')
        module.Imported = type('Imported', (Strategy,), {'__module__': 'external'})
        self.assertIs(resolver.resolve_strategy(module, Strategy), module.Local)

    def test_missing_invalid_and_abstract_entries_are_rejected(self):
        module = self.module('from abc import ABC, abstractmethod\nclass Abstract(Strategy, ABC):\n @abstractmethod\n def choose(self): pass\nvalue = 1')
        with self.assertRaisesRegex(ValueError, '未找到可实例化'):
            resolver.resolve_strategy(module, Strategy)

    def test_imported_class_alone_is_not_an_entrypoint(self):
        module = self.module('')
        module.Imported = type('Imported', (Strategy,), {'__module__': 'external'})
        with self.assertRaisesRegex(ValueError, '未找到可实例化'):
            resolver.resolve_strategy(module, Strategy)

    def test_real_worker_runs_with_auto_and_legacy_entrypoints(self):
        for entry in (None, '', 'WorkerStrategy', 'RetiredClassName'):
            with tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                (directory / 'strategy.py').write_text('from quant_sdk import Strategy\nclass WorkerStrategy(Strategy):\n def on_start(self, ctx): ctx.log("auto entry works")\n')
                config = {'parameters': {}}
                if entry is not None:
                    config['entrypoint'] = entry
                (directory / 'config.json').write_text(json.dumps(config))
                bar = Bar('TEST', 60, 120, '1970-01-01', 60, 100, 101, 99, 100, 10)
                Dataset([Instrument('TEST', 'future', 1, multiplier=1, margin_rate=1)], [Event('bar', 120, bar)]).save(directory / 'dataset.json')
                completed = subprocess.run([sys.executable, '-B', str(ROOT / 'worker/strategy_run.py'), str(ROOT / 'sdk'), temp], capture_output=True, text=True, timeout=20)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                result = json.loads((directory / 'result.json').read_text())
                self.assertEqual(result['status'], 'succeeded', result['message'])
                manifest = json.loads((directory / 'artifacts' / result['run_id'] / 'manifest.json').read_text())
                self.assertEqual(manifest['strategy_class'], 'WorkerStrategy')

    def test_public_scaffold_runs_without_orders_or_private_strategy_files(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'strategy.py').write_text((ROOT / 'sdk/templates/strategy.py').read_text())
            (directory / 'config.json').write_text(json.dumps({'parameters': {'symbol': 'TEST', 'duration': 60}}))
            events = []
            for index in range(40):
                price = 100 + (index if index < 20 else 40 - index)
                bar = Bar('TEST', index * 60, (index + 1) * 60, '1970-01-01', 60,
                          price, price + 1, price - 1, price, 1000)
                events.append(Event(str(index), bar.end_time, bar))
            Dataset([Instrument('TEST', 'future', 1, multiplier=1, margin_rate=1)], events).save(directory / 'dataset.json')
            completed = subprocess.run([sys.executable, '-B', str(ROOT / 'worker/strategy_run.py'), str(ROOT / 'sdk'), temp], capture_output=True, text=True, timeout=20)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads((directory / 'result.json').read_text())
            self.assertEqual(result['status'], 'succeeded', result['message'])
            for key in ('orders', 'fills', 'trades', 'signals', 'risk_levels'):
                self.assertEqual(result[key], [])
            self.assertEqual(result['metrics']['total_pnl'], 0)


if __name__ == '__main__':
    unittest.main()
