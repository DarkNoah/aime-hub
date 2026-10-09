import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { ChatRequestLog, createDataSource } from '@aime/db';
import {
  requestLogQuerySchema,
  type CapturedChatRequest,
  type RequestLogDetail,
} from '@aime/shared/request-logs';
import { createApp } from '../apps/server/src/app.js';
import { RequestLogService } from '../apps/server/src/modules/request-logs/service.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';

test('request log HTTP and RPC routes are admin-only and validate queries', async (t) => {
  const origin = 'http://localhost:5173';
  let user: { id: string; role: string } | undefined;
  const row: RequestLogDetail = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    method: 'POST',
    url: 'https://model.test/v1/chat/completions',
    model: 'test',
    stream: true,
    status: 'complete',
    bodyBytes: 2,
    body: '{}',
  };
  let calls = 0;
  const service = {
    async list() {
      calls++;
      const { body: _body, ...summary } = row;
      void _body;
      return { items: [summary], total: 1, nextCursor: null };
    },
    async get() {
      calls++;
      return row;
    },
  } as unknown as RequestLogService;
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, undefined, undefined, undefined, {
    service,
    webOrigin: origin,
  });
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set('origin', origin);
    return app.request(new Request(request, { headers }));
  });
  for (const role of [undefined, 'user', 'admin-assistant']) {
    user = role ? { id: 'tester', role } : undefined;
    for (const call of [
      () => client.requestLogs.list({ query: {} }),
      () => client.requestLogs.get({ params: { id: row.id } }),
    ])
      await assert.rejects(call(), {
        code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
      });
    for (const path of [
      '/api/admin/request-logs',
      `/api/admin/request-logs/${row.id}`,
    ]) {
      const response = await app.request(path);
      assert.equal(response.status, role ? 403 : 401);
    }
  }
  assert.equal(calls, 0);
  user = { id: 'tester', role: 'admin' };
  const list = await client.requestLogs.list({ query: {} });
  assert.equal('body' in list.items[0], false);
  assert.deepEqual(
    await client.requestLogs.get({ params: { id: row.id } }),
    row,
  );
  assert.equal((await app.request('/api/admin/request-logs')).status, 200);
  assert.deepEqual(
    await (await app.request(`/api/admin/request-logs/${row.id}`)).json(),
    row,
  );
  for (const query of ['limit=1000', 'status=failed', 'cursor=invalid']) {
    assert.equal(
      (await app.request(`/api/admin/request-logs?${query}`)).status,
      400,
    );
  }
  assert.equal(
    (await app.request('/api/admin/request-logs/not-an-id')).status,
    400,
  );
});

test(
  'request logs persist exact bodies, exclude bodies from lists and keep pagination stable',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `request_logs_test_${randomBytes(8).toString('hex')}`;
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
    await database.runMigrations();
    const service = new RequestLogService(database);
    const records: CapturedChatRequest[] = Array.from(
      { length: 5 },
      (_, index) => ({
        id: randomUUID(),
        createdAt: new Date(Date.UTC(2026, 9, 9, 0, 0, index)).toISOString(),
        method: 'POST',
        url: 'https://model.test/v1/chat/completions',
        complete: index !== 0,
        body:
          index === 0
            ? '{"partial":'
            : ` { "model": "model_${index}", "stream": true, "messages": [{"content":"你好🌍"}] }\n`,
      }),
    );
    for (const record of records) service.record(record);
    await service.settled();
    assert.equal(
      (
        await database
          .getRepository(ChatRequestLog)
          .findOneByOrFail({ id: records[4].id })
      ).body,
      undefined,
    );
    const first = await service.list(requestLogQuerySchema.parse({ limit: 2 }));
    assert.deepEqual(
      first.items.map((item) => item.id),
      [records[4].id, records[3].id],
    );
    assert.ok(first.items.every((item) => !('body' in item)));
    service.record({
      ...records[4],
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    await service.settled();
    const second = await service.list(
      requestLogQuerySchema.parse({ limit: 2, cursor: first.nextCursor }),
    );
    assert.deepEqual(
      second.items.map((item) => item.id),
      [records[2].id, records[1].id],
    );
    const partial = await service.list(
      requestLogQuerySchema.parse({ status: 'incomplete' }),
    );
    assert.equal(partial.items.length, 1);
    assert.equal(partial.items[0].model, null);
    assert.equal(
      (await service.list(requestLogQuerySchema.parse({ search: 'model_1' })))
        .total,
      1,
    );
    assert.equal(
      (await service.list(requestLogQuerySchema.parse({ search: '%' }))).total,
      0,
    );
    await database.destroy();
    await database.initialize();
    const reopened = new RequestLogService(database);
    for (const record of records) {
      const detail = await reopened.get(record.id);
      assert.equal(detail.body, record.body);
      assert.equal(detail.bodyBytes, Buffer.byteLength(record.body));
      assert.equal(detail.status, record.complete ? 'complete' : 'incomplete');
    }
    await assert.rejects(reopened.get(randomUUID()), { code: 'NOT_FOUND' });
  },
);
