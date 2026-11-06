"""SDK upgrades resume durable trading state without changing strategy identity."""
from copy import deepcopy
from datetime import date
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk'))
from quant_sdk import Fees, Instrument, LiveRunner, RunConfig, Strategy, __version__
from quant_sdk.checkpoint import CHECKPOINT_VERSION, LEGACY_CHECKPOINT_VERSIONS
from test_strategy_sdk import candle


class UpgradeStrategy(Strategy):
    def __init__(self):
        self.starts = self.stops = 0

    def on_start(self, ctx):
        self.starts += 1
        ctx.data.subscribe(ctx.params['symbol'], 60)

    def on_bar(self, ctx, bar):
        count = ctx.state.get('count', 0)
        ctx.state.update(count=count + 1, day=date(2026, 10, 19))
        targets = [1, 2, 0]
        if count < len(targets):
            ctx.orders.target_position(bar.symbol, targets[count], reason='upgrade fixture')
        if ctx.position(bar.symbol):
            ctx.set_risk_levels(bar.symbol, stop_loss=bar.close - 100)

    def on_stop(self, ctx, reason):
        self.stops += 1


class CheckpointCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.item = Instrument('CFFEX.IM2611', 'future', .2, multiplier=200,
                               margin_rate=.12, fees=Fees(per_unit=2))
        self.events = [candle(self.item.symbol, i, price)
                       for i, price in enumerate([8000, 8001, 8002, 8000, 7999])]
        self.options = dict(params={'symbol': self.item.symbol},
                            config=RunConfig(initial_cash=1_000_000),
                            mode='paper', output_dir=self.temp.name)
        runner = LiveRunner(UpgradeStrategy(), [self.item], **self.options)
        self.addCleanup(runner.journal.close)
        for event in self.events[:3]:
            runner.process(event)
        # Include undelivered output: upgrading must retain its stable identity.
        runner._output('upgrade_fixture', {'message': 'pending'})
        self.saved = json.loads(runner.checkpoint().read_text())
        self.current_hash = runner.runtime_hash
        runner.journal.close()
        self.assertEqual(sum(lot['quantity'] for lot in self.saved['broker']['lots']), 2)
        self.assertTrue(any(o['status'] == 'pending' for o in self.saved['broker']['orders']))
        self.assertTrue(self.saved['risk_levels'])
        self.assertTrue(self.saved['pending_outputs'])

    def checkpoint(self, manifest):
        value = deepcopy(self.saved)
        value['manifest'] = manifest
        path = Path(self.temp.name) / 'input-checkpoint.json'
        path.write_text(json.dumps(value))
        return path

    def assert_resume(self, manifest):
        path = self.checkpoint(manifest)
        original = path.read_bytes()
        delivered = []
        restored = LiveRunner.restore(UpgradeStrategy(), path, output_dir=self.temp.name,
                                      on_event=delivered.append)
        self.addCleanup(restored.journal.close)
        migrated = json.loads(restored.checkpoint().read_text())
        for key in self.saved.keys() - {'manifest'}:
            self.assertEqual(migrated[key], self.saved[key], key)
        self.assertEqual(restored.strategy.starts, 1)
        self.assertEqual(restored.context.state['day'], date(2026, 10, 19))
        self.assertEqual(delivered, [], 'restore must not deliver historical notifications')
        self.assertEqual(restored.manifest['checkpoint_version'], CHECKPOINT_VERSION)
        self.assertEqual(restored.manifest['sdk_version'], __version__)
        self.assertEqual(restored.manifest['runtime_hash'], self.current_hash)
        if manifest['runtime_hash'] != self.current_hash:
            self.assertEqual(restored.manifest['resumed_runtime_hash'], manifest['runtime_hash'])
        result = restored.run(self.events[2:])
        full = LiveRunner(UpgradeStrategy(), [self.item], **self.options).run(self.events)
        for field in ('signals', 'fills', 'trades', 'risk_levels', 'metrics'):
            self.assertEqual(result[field], full[field], field)
        self.assertEqual(sum(event['type'] == 'upgrade_fixture' for event in delivered), 1)
        self.assertEqual(path.read_bytes(), original, 'migration must preserve the source checkpoint')

    def test_reviewed_legacy_deployments_upgrade_automatically(self):
        for fingerprint in LEGACY_CHECKPOINT_VERSIONS:
            with self.subTest(runtime=fingerprint):
                manifest = deepcopy(self.saved['manifest'])
                manifest.pop('checkpoint_version')
                manifest.update(runtime_hash=fingerprint, sdk_version='0.1.0')
                self.assert_resume(manifest)

    def test_compatible_releases_resume_across_code_fingerprints(self):
        manifest = deepcopy(self.saved['manifest'])
        manifest['runtime_hash'] = 'another-compatible-build'
        self.assert_resume(manifest)

    def test_unversioned_identical_runtime_remains_supported(self):
        manifest = deepcopy(self.saved['manifest'])
        manifest.pop('checkpoint_version')
        self.assert_resume(manifest)

    def test_unknown_or_incompatible_versions_preserve_checkpoint_and_do_not_run_callbacks(self):
        for version in ('absent', None, True, '1', 0, CHECKPOINT_VERSION + 1):
            with self.subTest(version=version):
                manifest = deepcopy(self.saved['manifest'])
                if version == 'absent':
                    manifest.pop('checkpoint_version')
                    manifest['runtime_hash'] = 'unknown-legacy-build'
                else:
                    # Even an identical code hash must not override a version mismatch.
                    manifest['checkpoint_version'] = version
                path = self.checkpoint(manifest)
                original = path.read_bytes()
                strategy = UpgradeStrategy()
                with self.assertRaisesRegex(ValueError, 'SDK checkpoint version is incompatible'):
                    LiveRunner.restore(strategy, path, output_dir=self.temp.name)
                self.assertEqual((strategy.starts, strategy.stops), (0, 0))
                self.assertEqual(path.read_bytes(), original)

    def test_strategy_source_and_class_checks_remain_strict(self):
        for field, message in [('source_hash', 'Strategy source'), ('strategy_class', 'Strategy class')]:
            with self.subTest(field=field):
                manifest = deepcopy(self.saved['manifest'])
                manifest[field] = 'different'
                strategy = UpgradeStrategy()
                with self.assertRaisesRegex(ValueError, message):
                    LiveRunner.restore(strategy, self.checkpoint(manifest), output_dir=self.temp.name)
                self.assertEqual((strategy.starts, strategy.stops), (0, 0))


if __name__ == '__main__':
    unittest.main()
