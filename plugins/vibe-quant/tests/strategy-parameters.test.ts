import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  StrategyStore,
  type StoredStrategy,
} from '../server/strategies/store.js';
import type { QuantConfig } from '../server/config.js';
import { input } from './strategy-fixture.js';

test('queued runs freeze version defaults with explicit overrides without changing the version or caller', async (t) => {
  const defaults = {
    lookback: 14,
    quantity: 1,
    trailing_stop: true,
    threshold: 1,
    trading_calendar: { '2026-10-19': true },
  };
  const strategy: StoredStrategy = {
    id: randomUUID(),
    user_id: 'alice',
    name: 'parameters',
    description: '',
    enabled: true,
    revision: 2,
    version_count: 1,
    updated_at: new Date().toISOString(),
    draft_hash: 'draft',
    draft_parameters: { lookback: 999 },
    versions: [
      {
        id: randomUUID(),
        strategy_id: '',
        number: 1,
        source_hash: 'published',
        parameters: defaults,
        note: '',
        created_at: new Date().toISOString(),
      },
    ],
  };
  const store = new StrategyStore({
    clickhouseDatabase: 'test',
  } as QuantConfig);
  t.mock.method(store, 'storedStrategy', async () => structuredClone(strategy));
  const written: Record<string, unknown>[] = [];
  t.mock.method(store, 'execute', async (_query, _params, body) => {
    written.push(JSON.parse(JSON.parse(body!).payload).config.parameters);
    return { text: '', writtenRows: 1 };
  });
  const config = {
    ...input(strategy.versions[0].id),
    parameters: { quantity: 3, trailing_stop: false, threshold: 0 },
  };
  const before = structuredClone(config);
  const run = await store.enqueue('alice', strategy.id, config, 'tqsdk');
  assert.deepEqual(run.config.parameters, {
    ...defaults,
    ...config.parameters,
  });
  assert.deepEqual(written[0], run.config.parameters);
  assert.deepEqual(config, before);
  assert.equal(defaults.quantity, 1);
  assert.equal(run.config.parameters.lookback, 14);
  const inherited = await store.enqueue(
    'alice',
    strategy.id,
    { ...config, parameters: {} },
    'tqsdk',
  );
  assert.deepEqual(inherited.config.parameters, defaults);
  assert.deepEqual(written[1], defaults);
});
