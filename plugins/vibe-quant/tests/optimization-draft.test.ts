import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  StrategyStore,
  type StoredRun,
  type StoredStrategy,
} from '../server/strategies/store.js';
import type { QuantConfig } from '../server/config.js';
import type { StrategySources } from '../server/strategies/sources.js';
import { ClickHouseError } from '../server/clickhouse-client.js';
import { input } from './strategy-fixture.js';

class MemoryRecords extends StrategyStore {
  data = new Map<
    string,
    { value: StoredStrategy | StoredRun; revision: number }
  >();
  report: unknown = {
    status: 'completed',
    best_parameters: { fast: 7, slow: 99 },
    metric: 'sharpe',
    best_value: 1.2,
    completed_trials: 3,
    requested_trials: 3,
    validation: null,
  };
  failNext = false;
  override get sources() {
    return {
      read: async () => 'fixed published source',
    } as unknown as StrategySources;
  }
  override async rows<T>(
    query: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    let record = this.data.get(params.id);
    if (query.includes('arrayExists'))
      record = [...this.data.values()].find(
        (r) =>
          'versions' in r.value &&
          r.value.versions.some((v) => v.id === params.id),
      );
    if (!record || (params.owner && record.value.user_id !== params.owner))
      return [];
    return [
      { payload: JSON.stringify(record.value), revision: record.revision },
    ] as T[];
  }
  override async execute(
    _query: string,
    params: Record<string, string> = {},
    body?: string,
  ) {
    if (this.failNext) {
      this.failNext = false;
      throw new ClickHouseError(500, 241);
    }
    const previous = this.data.get(params.id);
    if ((previous?.revision ?? 0) !== Number(params.previous))
      return { text: '', writtenRows: 0 };
    const value = JSON.parse(JSON.parse(body!).payload);
    this.data.set(params.id, { value, revision: Number(params.next) });
    return { text: '', writtenRows: 1 };
  }
  override async artifact() {
    return this.report
      ? { hash: 'artifact-hash', text: JSON.stringify(this.report) }
      : null;
  }
}
function fixture() {
  const records = new MemoryRecords({
    clickhouseDatabase: 'test',
  } as QuantConfig);
  const strategyId = randomUUID(),
    versionId = randomUUID(),
    runId = randomUUID();
  const strategy: StoredStrategy = {
    id: strategyId,
    user_id: 'alice',
    name: 'Original',
    description: 'original rules',
    enabled: true,
    revision: 2,
    version_count: 1,
    updated_at: new Date().toISOString(),
    draft_hash: 'edited-hash',
    draft_parameters: { fast: 50 },
    versions: [
      {
        id: versionId,
        strategy_id: strategyId,
        number: 1,
        source_hash: 'published-hash',
        parameters: { fast: 2, slow: 4 },
        note: '',
        created_at: new Date().toISOString(),
      },
    ],
  };
  const run: StoredRun = {
    id: runId,
    user_id: 'alice',
    strategy_id: strategyId,
    version_id: versionId,
    version_number: 1,
    source_hash: 'published-hash',
    engine: 'tqsdk',
    status: 'completed',
    message: '',
    cancel_requested: false,
    worker_id: 'worker',
    heartbeat_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    config: {
      ...input(versionId),
      parameters: { slow: 6 },
      optimization: {
        search_space: { fast: { type: 'int', low: 2, high: 8 } },
        metric: 'sharpe',
        n_trials: 3,
        timeout_seconds: 600,
        seed: 42,
        min_trades: 1,
      },
    },
  };
  records.data.set(strategyId, { value: strategy, revision: 2 });
  records.data.set(runId, { value: run, revision: 1 });
  return { records, strategy, run };
}
test('optimization creates one separate unpublished draft and preserves edits on retry', async () => {
  const { records, strategy, run } = fixture();
  const before = JSON.stringify(strategy);
  const [first, second] = await Promise.all([
    records.createOptimizationDraft('alice', run.id),
    records.createOptimizationDraft('alice', run.id),
  ]);
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, strategy.id);
  assert.equal(first.version_count, 0);
  assert.equal(first.draft.source, 'fixed published source');
  assert.deepEqual(first.draft.parameters, { fast: 7, slow: 6 });
  assert.equal(JSON.stringify(strategy), before);
  assert.equal(
    (await records.run('alice', run.id)).optimization_draft_id,
    first.id,
  );
  const saved = records.data.get(first.id)!.value as StoredStrategy;
  saved.draft_parameters.fast = 11;
  assert.equal(
    (await records.createOptimizationDraft('alice', run.id)).draft.parameters
      .fast,
    11,
  );
});
test('draft creation rejects foreign owners and incomplete or missing optimization results', async () => {
  const { records, run } = fixture();
  await assert.rejects(records.createOptimizationDraft('bob', run.id), {
    code: 'RUN_NOT_FOUND',
  });
  run.status = 'cancelled';
  await assert.rejects(records.createOptimizationDraft('alice', run.id), {
    code: 'OPTIMIZATION_NOT_COMPLETED',
  });
  run.status = 'completed';
  records.report = null;
  await assert.rejects(records.createOptimizationDraft('alice', run.id), {
    code: 'OPTIMIZATION_RESULT_MISSING',
  });
  assert.equal(records.data.size, 2);
});
test('a transient ClickHouse memory error does not lose the worker heartbeat', async () => {
  const { records, run } = fixture();
  run.status = 'running';
  records.failNext = true;
  assert.equal(await records.heartbeat(run.id, 'worker'), true);
  assert.equal(await records.heartbeat(run.id, 'another-worker'), false);
});
