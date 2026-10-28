import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PluginContext } from '@app/plugin-sdk/server';
import { strategyFixture, input } from './strategy-fixture.js';
import { optimizationSchema } from '../server/strategies/optimization.js';
import { strategyRoutes } from '../server/strategies/routes.js';

test('public template works in a deployment without private examples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quant-public-template-'));
  try {
    await mkdir(join(root, 'sdk/templates'), { recursive: true });
    await copyFile(
      resolve('plugins/vibe-quant/sdk/templates/strategy.py'),
      join(root, 'sdk/templates/strategy.py'),
    );
    const unavailable = (): never => {
      throw new Error('Template must not depend on strategy storage');
    };
    const api = strategyRoutes(
      { runtime: { paths: { pluginRoot: root } } } as unknown as PluginContext,
      unavailable,
      unavailable,
    );
    const response = await api.request('/template');
    assert.equal(response.status, 200);
    const template = await response.json();
    assert.match(template.source, /class CustomStrategy/);
    assert.doesNotMatch(template.source, /ctx\.orders|RiskLevels/);
    assert.deepEqual(template.parameters, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'shared strategies support cross-account editing, versions, runs and optimization drafts without changing attribution',
  { skip: process.env.QUANT_STRATEGY_INTEGRATION !== '1', timeout: 60000 },
  async () => {
    const f = await strategyFixture();
    const bob = { 'x-user': 'bob' };
    const body = {
      name: 'Shared strategy',
      description: '',
      enabled: true,
      draft: { source: '# shared source', parameters: { fast: 2 } },
    };
    try {
      const created = await f.records.save('alice', body);
      const list = await f.request('/strategies', 'GET', undefined, bob);
      assert.equal(list.status, 200);
      assert.equal((await list.json())[0].id, created.id);
      const changed = await f.request(
        `/strategies/${created.id}`,
        'PUT',
        {
          ...body,
          name: 'Edited by Bob',
          revision: created.revision,
        },
        bob,
      );
      assert.equal(changed.status, 200);
      const edited = await changed.json();
      assert.equal(
        (await f.records.storedStrategy(created.id)).user_id,
        'alice',
      );
      await assert.rejects(
        f.records.save('alice', body, created.id, created.revision),
        {
          code: 'STRATEGY_CONFLICT',
        },
      );
      const response = await f.request(
        `/strategies/${created.id}/versions`,
        'POST',
        {
          revision: edited.revision,
          note: 'Shared version',
        },
        bob,
      );
      assert.equal(response.status, 201);
      const published = await response.json();
      assert.deepEqual(
        await f.records.versions('alice', created.id),
        await f.records.versions('bob', created.id),
      );
      assert.equal(
        (await f.records.version('bob', published.version.id)).source,
        body.draft.source,
      );
      const config = input(published.version.id);
      assert.equal(
        (
          await f.request(`/strategies/${created.id}/runs`, 'POST', config, {
            ...bob,
            'x-admin': 'false',
          })
        ).status,
        403,
      );
      const queued = await f.request(
        `/strategies/${created.id}/runs`,
        'POST',
        config,
        bob,
      );
      assert.equal(queued.status, 202);
      const bobRun = await queued.json();
      const aliceRun = await f.records.enqueue(
        'alice',
        created.id,
        config,
        'tqsdk',
      );
      const runs = await f.records.runs('bob', created.id);
      assert.deepEqual(
        new Set(runs.map((run) => run.id)),
        new Set([bobRun.id, aliceRun.id]),
      );
      assert.deepEqual(await f.records.runs('alice', created.id), runs);
      assert.deepEqual(
        (await f.records.runs('bob', created.id, runs[0].id)).map(
          (run) => run.id,
        ),
        [runs[1].id],
      );
      assert.equal(
        (
          await f.request(
            `/strategies/runs/${aliceRun.id}/status`,
            'GET',
            undefined,
            bob,
          )
        ).status,
        200,
      );
      await f.records.cancel('alice', bobRun.id);
      assert.equal((await f.records.run('bob', bobRun.id)).status, 'cancelled');
      const optimizationId = randomUUID();
      await f.records.importRun({
        ...aliceRun,
        id: optimizationId,
        status: 'completed',
        config: {
          ...config,
          optimization: optimizationSchema.parse({
            search_space: { fast: { type: 'int', low: 2, high: 10 } },
          }),
        },
      });
      await f.records.putArtifact(
        optimizationId,
        'optimization',
        JSON.stringify({
          status: 'completed',
          best_parameters: { fast: 9 },
          metric: 'sharpe',
          best_value: 1,
          completed_trials: 1,
          requested_trials: 1,
        }),
      );
      const drafts = await Promise.all(
        ['bob', 'alice'].map((actor) =>
          f.records.createOptimizationDraft(actor, optimizationId),
        ),
      );
      assert.equal(drafts[0].id, drafts[1].id);
      assert.equal(drafts[0].draft.parameters.fast, 9);
      assert.equal(drafts[0].version_count, 0);
      assert.equal(
        (await f.records.detail('bob', created.id)).draft.parameters.fast,
        2,
      );
      assert.equal(
        (await f.records.runs('bob', created.id, undefined, 'optimization'))[0]
          .id,
        optimizationId,
      );
      assert.equal(
        (
          await f.request(
            `/strategies/optimizations/${optimizationId}/result`,
            'GET',
            undefined,
            bob,
          )
        ).status,
        200,
      );
      const archived = await f.records.setStatus(
        'bob',
        created.id,
        published.strategy.revision,
        'archived',
      );
      assert.equal(
        (await f.records.list('alice', 'archived'))[0].id,
        created.id,
      );
      await assert.rejects(
        f.records.save('alice', body, created.id, archived.revision),
        {
          code: 'STRATEGY_ARCHIVED',
        },
      );
      const restored = await f.records.setStatus(
        'alice',
        created.id,
        archived.revision,
        'active',
      );
      await f.records.setStatus(
        'bob',
        created.id,
        restored.revision,
        'deleted',
      );
      assert.equal(
        (await f.records.list('alice', 'deleted'))[0].id,
        created.id,
      );
      assert.equal(
        (await f.records.version('bob', published.version.id)).source,
        body.draft.source,
      );
    } finally {
      await f.close();
    }
  },
);
