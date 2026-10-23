import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StrategyStore,
  type StoredStrategy,
} from '../server/strategies/store.js';
import { StrategySources } from '../server/strategies/sources.js';
import type { QuantConfig } from '../server/config.js';

test('legacy entrypoint fields are hidden on reads and omitted from new drafts and versions', async (t) => {
  const version = {
    id: 'version',
    strategy_id: 'strategy',
    number: 1,
    source_hash: 'hash',
    entrypoint: 'OldClass',
    parameters: { quantity: 1 },
    note: '',
    created_at: '2026-10-23',
  };
  const legacy = {
    id: 'strategy',
    user_id: 'alice',
    name: 'ORB',
    description: '',
    enabled: true,
    revision: 2,
    version_count: 1,
    updated_at: '2026-10-23',
    draft_hash: 'hash',
    draft_entrypoint: 'OldClass',
    draft_parameters: { quantity: 1 },
    versions: [version],
  };
  const before = structuredClone(legacy);
  const store = new StrategyStore({
    clickhouseDatabase: 'test',
  } as QuantConfig);
  t.mock.method(store, 'storedStrategy', async () => legacy);
  t.mock.method(store, 'rows', async () => [
    { payload: JSON.stringify(legacy) },
  ]);
  t.mock.method(
    StrategySources.prototype,
    'read',
    async () => 'class NewClass(Strategy): pass',
  );
  t.mock.method(
    StrategySources.prototype,
    'readMany',
    async () => new Map([['hash', 'class NewClass(Strategy): pass']]),
  );
  t.mock.method(StrategySources.prototype, 'put', async () => 'new-hash');
  const written: StoredStrategy[] = [];
  t.mock.method(store, 'execute', async (_query, _params, body) => {
    written.push(JSON.parse(JSON.parse(body!).payload));
    return { text: '', writtenRows: 1 };
  });

  const detail = await store.detail('alice', 'strategy');
  assert.deepEqual(Object.keys(detail.draft).sort(), ['parameters', 'source']);
  const versions = await store.versions('alice', 'strategy');
  const single = await store.version('alice', 'version');
  assert.deepEqual(versions[0], single);
  assert.equal(Object.hasOwn(single, 'entrypoint'), false);
  assert.equal(single.source_hash, version.source_hash);

  await store.save('alice', { ...detail, draft: detail.draft }, 'strategy', 2);
  assert.equal(Object.hasOwn(written[0], 'draft_entrypoint'), false);
  assert.deepEqual(written[0].versions, legacy.versions);
  const published = await store.publish('alice', 'strategy', 2, 'automatic');
  assert.equal(Object.hasOwn(published.version, 'entrypoint'), false);
  assert.equal(Object.hasOwn(written[1].versions[1], 'entrypoint'), false);
  assert.deepEqual(legacy, before);
});
