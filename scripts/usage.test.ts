import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createDataSource, UsageRecord } from '@aime/db';
import { usageQuerySchema, usageRecordsQuerySchema } from '@aime/shared/usage';
import { runtimeTokenCounts } from '../apps/server/src/modules/usage/runtime.js';
import { UsageService } from '../apps/server/src/modules/usage/service.js';
import { createApp } from '../apps/server/src/app.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';
import {
  dailySeries,
  dateRange,
} from '../apps/web/src/pages/admin/usage/format.js';

const range = {
  from: '2026-10-12',
  to: '2026-10-13',
  timezone: 'Asia/Shanghai',
};

test('runtime usage preserves unknown values and counts breakdowns without double counting', () => {
  assert.deepEqual(
    runtimeTokenCounts({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 5,
      reasoningTokens: 10,
    }),
    {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 80,
      cacheCreationInputTokens: 5,
      reasoningTokens: 10,
    },
  );
  assert.equal(
    runtimeTokenCounts({ inputTokens: 100, outputTokens: 20, totalTokens: 150 })
      .totalTokens,
    150,
  );
  assert.equal(runtimeTokenCounts({ inputTokens: 10 }).totalTokens, null);
  assert.equal(
    runtimeTokenCounts({ inputTokens: 0, outputTokens: 0 }).totalTokens,
    0,
  );
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      runtimeTokenCounts({ inputTokens: value, outputTokens: 10 }).inputTokens,
      null,
    );
    assert.equal(runtimeTokenCounts({ totalTokens: value }).totalTokens, null);
  }
});

test('range validation and daily charts use inclusive calendar days and fill missing days', () => {
  for (const input of [
    { ...range, from: '2026-02-30' },
    { ...range, from: '2026-10-14' },
    { ...range, from: '2025-01-01' },
    { ...range, timezone: "UTC'; SELECT 1" },
  ])
    assert.equal(usageQuerySchema.safeParse(input).success, false);
  assert.equal(
    usageRecordsQuerySchema.safeParse({ ...range, limit: 101 }).success,
    false,
  );
  assert.equal(
    usageRecordsQuerySchema.safeParse({
      ...range,
      cursor: { id: 'bad', createdAt: 'bad' },
    }).success,
    false,
  );
  assert.deepEqual(
    dateRange(7, 'Asia/Shanghai', new Date('2026-10-12T23:00:00Z')),
    { from: '2026-10-07', to: '2026-10-13' },
  );
  assert.deepEqual(
    dailySeries([], range).map((day) => [day.date, day.totalTokens]),
    [
      ['2026-10-12', 0],
      ['2026-10-13', 0],
    ],
  );
});

test('usage HTTP and RPC endpoints enforce administrator access and validate date ranges', async (t) => {
  let role: string | undefined;
  let calls = 0;
  const auth = {
    api: {
      getSession: async () => (role ? { user: { id: 'test', role } } : null),
    },
  } as unknown as Parameters<typeof createApp>[0];
  const service = {
    summary: async () => {
      calls++;
      return {};
    },
    records: async () => {
      calls++;
      return { items: [], nextCursor: null };
    },
  } as unknown as UsageService;
  const origin = 'http://localhost:5173';
  const app = createApp(
    auth,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { service, webOrigin: origin },
  );
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set('origin', origin);
    return app.request(new Request(request, { headers }));
  });
  const query = new URLSearchParams(range).toString();
  for (const value of [undefined, 'user', 'admin-assistant']) {
    role = value;
    for (const method of ['summary', 'records'] as const) {
      await assert.rejects(client.usage[method]({ query: range }), {
        code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
      });
      assert.equal(
        (
          await app.request(
            `/api/admin/usage${method === 'records' ? '/records' : ''}?${query}`,
          )
        ).status,
        role ? 403 : 401,
      );
    }
  }
  assert.equal(calls, 0);
  role = 'admin';
  await client.usage.summary({ query: range });
  await client.usage.records({ query: range });
  assert.equal(calls, 2);
  assert.equal((await app.request(`/api/admin/usage?${query}`)).status, 200);
  for (const suffix of [
    'from=2026-10-14&to=2026-10-13',
    'from=2020-01-01&to=2026-10-13',
    `${query}&timezone=invalid`,
  ])
    assert.equal((await app.request(`/api/admin/usage?${suffix}`)).status, 400);
});

function record(patch: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: randomUUID(),
    createdAt: new Date('2026-10-12T02:00:00Z'),
    finishedAt: new Date('2026-10-12T02:00:01Z'),
    userId: 'alice',
    projectId: 'project-1',
    threadId: 'thread-1',
    runId: 'run-1',
    agentId: 'code:default',
    stepNumber: 0,
    providerId: 'provider-1',
    model: 'actual-model',
    modelReference: 'provider-1/configured-model',
    durationMs: 1000,
    finishReason: 'stop',
    ...runtimeTokenCounts({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      reasoningTokens: 10,
    }),
    ...patch,
  };
}

test(
  'usage database migration, idempotency, timezone aggregation, filters and stable pagination',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `usage_test_${randomBytes(8).toString('hex')}`;
    const url = process.env.TEST_DATABASE_URL!;
    const pool = new Pool({ connectionString: url });
    const database = createDataSource(url).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
    });
    t.after(async () => {
      if (database.isInitialized) await database.destroy();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.query(
      'CREATE TABLE users (id text PRIMARY KEY, name text, username text)',
    );
    await database.query('CREATE TABLE sessions (id text PRIMARY KEY)');
    await database.runMigrations();
    await database.undoLastMigration();
    await database.runMigrations();
    await database.query(
      "INSERT INTO users VALUES ('alice', 'Alice', 'alice'), ('bob', 'Bob', 'bob')",
    );
    await database.query(
      "INSERT INTO projects (id, name, created_by) VALUES ('project-1', 'Project one', 'alice')",
    );
    await database.query(
      "INSERT INTO providers (id, name, type, base_url) VALUES ('provider-1','Provider one','newapi','https://example.test')",
    );
    const service = new UsageService(database);
    const first = record();
    const second = record({
      userId: 'bob',
      createdAt: new Date('2026-10-12T16:00:00Z'),
      providerId: 'provider-2',
      projectId: null,
    });
    const missing = record({
      createdAt: new Date('2026-10-13T15:59:59Z'),
      ...runtimeTokenCounts({}),
    });
    for (const row of [
      first,
      first,
      second,
      missing,
      record({ createdAt: new Date('2026-10-11T15:59:59Z') }),
      record({ createdAt: new Date('2026-10-13T16:00:00Z') }),
    ])
      await service.record(row);
    const summary = await service.summary(range);
    assert.equal(summary.totals.requests, 3);
    assert.equal(summary.totals.reportedRequests, 2);
    assert.equal(summary.totals.totalTokens, 240);
    assert.equal(summary.totals.cachedInputTokens, 100);
    assert.equal(summary.totals.reasoningTokens, 20);
    assert.equal(summary.totals.averageDurationMs, 1000);
    assert.deepEqual(
      summary.daily.map((day) => [day.date, day.requests]),
      [
        ['2026-10-12', 1],
        ['2026-10-13', 2],
      ],
    );
    assert.ok(
      summary.heatmap.some(
        (cell) =>
          cell.weekday === 2 && cell.hour === 0 && cell.totalTokens === 120,
      ),
    );
    assert.equal(
      summary.users.find((row) => row.id === 'alice')?.name,
      'Alice',
    );
    assert.equal(
      summary.projects.find((row) => row.id === 'project-1')?.name,
      'Project one',
    );
    assert.equal(
      summary.models.length,
      2,
      'same model on two providers stays separate',
    );
    assert.equal(
      (await service.summary({ ...range, userId: 'bob' })).totals.requests,
      1,
    );
    assert.equal(
      (await service.summary({ ...range, projectId: '__none__' })).totals
        .requests,
      1,
    );
    assert.equal(
      (
        await service.summary({
          ...range,
          providerId: 'provider-2',
          model: 'actual-model',
        })
      ).totals.totalTokens,
      120,
    );
    assert.equal(
      (await service.summary({ ...range, userId: "' OR 1=1 --" })).totals
        .requests,
      0,
    );
    const page = await service.records(
      usageRecordsQuerySchema.parse({ ...range, limit: 1 }),
    );
    assert.equal(page.items[0].id, missing.id);
    assert.equal(page.items[0].totalTokens, null);
    await service.record(
      record({ createdAt: new Date('2026-10-13T15:59:59.999Z') }),
    );
    const next = await service.records(
      usageRecordsQuerySchema.parse({
        ...range,
        limit: 1,
        cursor: page.nextCursor,
      }),
    );
    assert.equal(next.items[0].id, second.id);
    assert.equal(next.items[0].projectName, null);
    assert.equal(next.items[0].inputTokens, 100);
    assert.equal('body' in next.items[0], false);
    // A 23-hour daylight-saving day must use calendar boundaries in the chosen zone.
    for (const createdAt of [
      '2026-03-08T04:59:59Z',
      '2026-03-08T05:00:00Z',
      '2026-03-09T03:59:59Z',
      '2026-03-09T04:00:00Z',
    ])
      await service.record(record({ createdAt: new Date(createdAt) }));
    assert.equal(
      (
        await service.summary({
          from: '2026-03-08',
          to: '2026-03-08',
          timezone: 'America/New_York',
        })
      ).totals.requests,
      2,
    );
    await database.query("DELETE FROM users WHERE id = 'alice'");
    assert.equal(
      (await service.summary(range)).users.find((row) => row.id === 'alice')
        ?.name,
      null,
    );
    await database.destroy();
    await database.initialize();
    assert.equal(
      (await new UsageService(database).summary(range)).totals.requests,
      4,
    );
  },
);

test('usage persistence failure is isolated from a successful runtime step', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const database = {
    getRepository() {
      throw new Error('private database information');
    },
  } as unknown as ConstructorParameters<typeof UsageService>[0];
  const row = record();
  await new UsageService(database).record(row);
  assert.deepEqual(errors, [['Failed to persist runtime usage', row.id]]);
});
