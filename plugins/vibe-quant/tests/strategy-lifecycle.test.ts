import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import { StrategyStore } from '../server/strategies/store.js';
import { strategyRoutes } from '../server/strategies/routes.js';
import { parseConfig } from '../server/config.js';
import type { StrategyStatus } from '../strategy-types.js';
import { input } from './strategy-fixture.js';

const body = {
  name: 'Lifecycle test',
  description: 'Preserve history',
  enabled: true,
  draft: { source: 'class Example: pass', parameters: { quantity: 1 } },
};
const testConfig = parseConfig({
  engine: 'tqsdk',
  tqUser: 'fixture',
  tqPassword: 'fixture',
  clickhouseUrl: 'http://127.0.0.1:18124',
  clickhouseDatabase: 'lifecycle_test',
  clickhouseUser: 'test',
  clickhousePassword: 'test-only-local',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 5,
  flushSeconds: 1,
  pollSeconds: 5,
  historyBars: 100,
  maxSubscriptions: 10,
});
function api(records: StrategyStore) {
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    c.set('isAdmin', false);
    await next();
  });
  app.route(
    '/strategies',
    strategyRoutes(
      {} as PluginContext,
      () => records,
      () => {
        throw new Error('Lifecycle operations must not start market workers');
      },
    ),
  );
  return app;
}
const patch = (
  app: ReturnType<typeof api>,
  id: string,
  value: unknown,
  user = 'alice',
) =>
  app.request(`/strategies/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user': user },
    body: JSON.stringify(value),
  });

test('lifecycle API validates status/revision and passes authenticated ownership', async () => {
  const calls: unknown[][] = [];
  const records = {
    list: async (...args: unknown[]) => {
      calls.push(['list', ...args]);
      return [];
    },
    setStatus: async (...args: unknown[]) => {
      calls.push(['status', ...args]);
      return { status: args[3] };
    },
  } as unknown as StrategyStore;
  const app = api(records),
    id = randomUUID();
  await app.request('/strategies');
  for (const status of ['archived', 'deleted', 'all'])
    assert.equal(
      (await app.request(`/strategies?status=${status}`)).status,
      200,
    );
  assert.deepEqual(
    calls,
    ['active', 'archived', 'deleted', 'all'].map((status) => [
      'list',
      'alice',
      status,
    ]),
  );
  calls.length = 0;
  assert.equal(
    (await patch(app, id, { status: 'archived', revision: 2 }, 'bob')).status,
    200,
  );
  assert.deepEqual(calls, [['status', 'bob', id, 2, 'archived']]);
  calls.length = 0;
  for (const value of [
    null,
    {},
    { status: 'deleted' },
    { revision: 1, status: 'purged' },
    { revision: 0, status: 'active' },
  ])
    assert.equal((await patch(app, id, value)).status, 400);
  assert.equal(
    (await patch(app, 'invalid', { revision: 1, status: 'deleted' })).status,
    404,
  );
  assert.equal((await app.request('/strategies?status=unknown')).status, 400);
  assert.deepEqual(calls, []);
});

test('archived and deleted strategies reject draft writes, publishing and enqueueing before side effects', async (t) => {
  const records = new StrategyStore(testConfig);
  for (const status of ['archived', 'deleted'] as const) {
    const mocked = t.mock.method(records, 'storedStrategy', async () => ({
      status,
      revision: 1,
      enabled: true,
    }));
    const code =
      status === 'archived' ? 'STRATEGY_ARCHIVED' : 'STRATEGY_DELETED';
    await assert.rejects(records.save('alice', body, 'id', 1), { code });
    await assert.rejects(records.publish('alice', 'id', 1, ''), { code });
    await assert.rejects(
      records.enqueue('alice', 'id', input(randomUUID()), 'tqsdk'),
      { code },
    );
    mocked.mock.restore();
  }
});

const integration = process.env.QUANT_STRATEGY_INTEGRATION === '1';
async function database() {
  const config = {
    ...testConfig,
    clickhouseDatabase: `lifecycle_test_${randomUUID().replaceAll('-', '')}`,
  };
  const records = new StrategyStore(config);
  await records.request(`CREATE DATABASE ${config.clickhouseDatabase}`);
  await records.initialize();
  return {
    records,
    config,
    close: () => records.request(`DROP DATABASE ${config.clickhouseDatabase}`),
  };
}

test(
  'ClickHouse lifecycle retains history, isolates owners, restores enabled state and reads legacy strategies',
  { skip: !integration, timeout: 60000 },
  async () => {
    const f = await database();
    try {
      const { records } = f;
      const app = api(records);
      const created = await records.save('alice', { ...body, enabled: false });
      const published = await records.publish(
        'alice',
        created.id,
        created.revision,
        'fixed',
      );
      // Import a legacy record without lifecycle metadata.
      const legacy = await records.storedStrategy(created.id, 'alice');
      legacy.id = randomUUID();
      legacy.versions = [];
      legacy.version_count = 0;
      delete legacy.status;
      await records.importStrategy(legacy);
      assert.equal((await records.detail('alice', legacy.id)).status, 'active');
      assert.equal((await records.list('alice')).length, 2);
      const enabled = await records.save(
        'alice',
        body,
        created.id,
        published.strategy.revision,
      );
      const queued = await records.enqueue(
        'alice',
        created.id,
        input(published.version.id),
        'tqsdk',
      );
      await records.putArtifact(queued.id, 'result', '{"kept":true}');
      const disabled = await records.save(
        'alice',
        { ...body, enabled: false },
        created.id,
        enabled.revision,
      );
      for (const status of ['archived', 'deleted'] as const) {
        const previous = await records.detail('alice', created.id);
        const response = await patch(app, created.id, {
          status,
          revision: previous.revision,
        });
        assert.equal(response.status, 200);
        const next = await response.json();
        assert.equal(next.status, status);
        assert.equal(next.revision, previous.revision + 1);
        assert.equal(next.enabled, false);
        assert.equal(
          (await records.list('alice')).some((v) => v.id === created.id),
          false,
        );
        assert.deepEqual(
          (await records.list('alice', status)).map((v) => v.id),
          [created.id],
        );
        assert.deepEqual(await records.list('bob', 'all'), []);
        assert.deepEqual(
          (await records.detail('alice', created.id)).draft,
          disabled.draft,
        );
        assert.deepEqual(await records.versions('alice', created.id), [
          published.version,
        ]);
        assert.equal(
          (await records.runs('alice', created.id))[0].id,
          queued.id,
        );
        assert.equal(
          (await records.artifact(queued.id, 'result'))?.text,
          '{"kept":true}',
        );
        assert.equal((await records.run('alice', queued.id)).status, 'queued');
        assert.equal(
          (
            await patch(
              app,
              created.id,
              { status: 'active', revision: next.revision },
              'bob',
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await patch(app, created.id, {
              status: 'active',
              revision: previous.revision,
            })
          ).status,
          409,
        );
      }
      const deleted = await records.detail('alice', created.id);
      const restored = await records.setStatus(
        'alice',
        created.id,
        deleted.revision,
        'active',
      );
      assert.equal(restored.enabled, false);
      assert.equal(restored.status, 'active');
      assert.equal((await records.list('alice')).length, 2);
      assert.deepEqual(await records.list('alice', 'deleted'), []);
      assert.equal(
        (
          await records.setStatus(
            'alice',
            created.id,
            restored.revision,
            'active',
          )
        ).revision,
        restored.revision,
      );
      const saved = await records.save(
        'alice',
        body,
        created.id,
        restored.revision,
      );
      assert.equal(saved.status, 'active');
      assert.equal(
        (
          await records.publish(
            'alice',
            created.id,
            saved.revision,
            'after restore',
          )
        ).version.number,
        2,
      );
      const summary = await (
        await app.request('/strategies?status=all')
      ).json();
      assert.equal(summary.length, 2);
      await assert.rejects(records.versions('bob', created.id), {
        code: 'STRATEGY_NOT_FOUND',
      });
      await assert.rejects(records.run('bob', queued.id), {
        code: 'RUN_NOT_FOUND',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'ClickHouse CAS prevents stale writes and enqueue after concurrent lifecycle changes',
  { skip: !integration, timeout: 60000 },
  async (t) => {
    const f = await database();
    try {
      const other = new StrategyStore(f.config);
      for (const status of ['archived', 'deleted'] as StrategyStatus[]) {
        const created = await f.records.save('alice', body);
        const results = await Promise.allSettled([
          f.records.setStatus('alice', created.id, created.revision, status),
          other.save(
            'alice',
            { ...body, name: 'concurrent edit' },
            created.id,
            created.revision,
          ),
        ]);
        assert.equal(results.filter((v) => v.status === 'fulfilled').length, 1);
        for (const result of results)
          if (result.status === 'rejected')
            assert.equal(result.reason.code, 'STRATEGY_CONFLICT');
        const current = await f.records.detail('alice', created.id);
        assert.equal(current.revision, created.revision + 1);
        const restored = await f.records.setStatus(
          'alice',
          created.id,
          current.revision,
          'active',
        );
        const published = await f.records.publish(
          'alice',
          created.id,
          restored.revision,
          '',
        );
        const execute = f.records.execute.bind(f.records);
        const mock = t.mock.method(
          f.records,
          'execute',
          async (...args: Parameters<typeof execute>) => {
            if (args[1]?.strategy === created.id)
              await other.setStatus(
                'alice',
                created.id,
                published.strategy.revision,
                status,
              );
            return execute(...args);
          },
        );
        await assert.rejects(
          f.records.enqueue(
            'alice',
            created.id,
            input(published.version.id),
            'tqsdk',
          ),
          {
            code:
              status === 'archived' ? 'STRATEGY_ARCHIVED' : 'STRATEGY_DELETED',
          },
        );
        mock.mock.restore();
        assert.deepEqual(await f.records.runs('alice', created.id), []);
      }
    } finally {
      await f.close();
    }
  },
);
