import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { ChatRequestLog, createDataSource } from '@aime/db';
import {
  requestLogQuerySchema,
  requestLogContextFields,
  type CapturedChatRequest,
  type CapturedChatResponse,
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
    threadId: 'thread-1',
    resourceId: 'project:project-1',
    userId: 'user-1',
    projectId: 'project-1',
    model: 'test',
    stream: true,
    status: 'complete',
    bodyBytes: 2,
    body: '{}',
    durationMs: 1250,
    httpStatus: 200,
    responseStatus: 'complete',
    responseContentType: 'application/json',
    responseContentEncoding: null,
    responseBytes: 2,
    responseBodyEncoding: 'utf8',
    responseBody: '{}',
  };
  let calls = 0;
  let lastQuery;
  const service = {
    async list(query: unknown) {
      lastQuery = query;
      calls++;
      const { body: _body, responseBody: _responseBody, ...summary } = row;
      void _body;
      void _responseBody;
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
  assert.equal('responseBody' in list.items[0], false);
  assert.deepEqual(
    await client.requestLogs.get({ params: { id: row.id } }),
    row,
  );
  assert.equal((await app.request('/api/admin/request-logs')).status, 200);
  const filters = {
    threadId: 'thread-1',
    resourceId: 'project:project-1',
    userId: 'user-1',
    projectId: 'project-1',
  };
  await client.requestLogs.list({ query: filters });
  assert.deepEqual(lastQuery, requestLogQuerySchema.parse(filters));
  assert.equal(
    (
      await app.request(
        `/api/admin/request-logs?${new URLSearchParams(filters)}`,
      )
    ).status,
    200,
  );
  assert.deepEqual(lastQuery, requestLogQuerySchema.parse(filters));
  assert.deepEqual(
    await (await app.request(`/api/admin/request-logs/${row.id}`)).json(),
    row,
  );
  for (const query of [
    'limit=1000',
    'status=failed',
    'cursor=invalid',
    ...requestLogContextFields.map((field) => `${field}=${'a'.repeat(201)}`),
  ]) {
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
    // Upgrade an existing log table, and exercise the new migration's rollback.
    await database.undoLastMigration();
    await database.undoLastMigration();
    const legacyId = randomUUID();
    await database.query(
      `INSERT INTO chat_request_logs (id, created_at, method, url, status, body_bytes, body) VALUES ($1, '2020-01-01', 'POST', 'https://old.test/responses', 'complete', 2, '{}')`,
      [legacyId],
    );
    await database.runMigrations();
    const service = new RequestLogService(database);
    const legacy = await service.get(legacyId);
    for (const field of requestLogContextFields)
      assert.equal(legacy[field], null);
    assert.equal(legacy.responseBody, null);
    assert.equal(legacy.durationMs, null);
    assert.equal(legacy.responseStatus, null);
    const indexes = await database.query(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
      [schema, 'chat_request_logs'],
    );
    assert.equal(indexes.length, 6);
    const records: CapturedChatRequest[] = Array.from(
      { length: 5 },
      (_, index) => ({
        id: randomUUID(),
        createdAt: new Date(Date.UTC(2026, 9, 9, 0, 0, index)).toISOString(),
        method: 'POST',
        url: 'https://model.test/v1/chat/completions',
        threadId: index ? `thread_${index}` : null,
        resourceId: index ? `project:resource_${index}` : null,
        userId: index ? `user_${index}` : null,
        projectId: index ? `project_${index}` : null,
        complete: index !== 0,
        body:
          index === 0
            ? '{"partial":'
            : ` { "model": "model_${index}", "stream": true, "messages": [{"content":"你好🌍"}] }\n`,
      }),
    );
    for (const record of records) service.record(record);
    const responses: CapturedChatResponse[] = records.map((record, index) => ({
      id: record.id,
      durationMs: index * 1000 + 125,
      httpStatus: index === 0 ? null : index === 1 ? 500 : 200,
      responseStatus: index === 0 || index === 2 ? 'incomplete' : 'complete',
      responseContentType: index === 0 ? null : 'text/event-stream',
      responseContentEncoding: null,
      responseBytes:
        index === 0 ? 0 : Buffer.byteLength('data: {"delta":"你好🌍"}\n\n'),
      responseBody: index === 0 ? null : 'data: {"delta":"你好🌍"}\n\n',
      responseBodyEncoding: index === 0 ? null : 'utf8',
    }));
    // Enqueue immediately after insert: completion must not race row creation.
    for (const response of responses.slice(0, 4))
      service.recordResponse(response);
    await service.settled();
    const pending = await service.get(records[4].id);
    assert.equal(pending.responseStatus, 'pending');
    assert.equal(pending.durationMs, null);
    assert.equal(pending.responseBody, null);
    service.recordResponse(responses[4]);
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
    assert.ok(first.items.every((item) => !('responseBody' in item)));
    assert.equal(first.items[0].durationMs, responses[4].durationMs);
    assert.equal(first.items[0].httpStatus, 200);
    assert.equal(
      (
        await database
          .getRepository(ChatRequestLog)
          .findOneByOrFail({ id: records[4].id })
      ).responseBody,
      undefined,
    );
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
    for (const field of requestLogContextFields) {
      const value = records[1][field]!;
      const filtered = await service.list(
        requestLogQuerySchema.parse({ [field]: ` ${value} ` }),
      );
      assert.deepEqual(
        filtered.items.map((item) => item.id),
        [records[1].id],
      );
      assert.equal(filtered.total, 1);
      assert.equal(
        (await service.list(requestLogQuerySchema.parse({ search: value })))
          .total,
        1,
      );
      assert.equal(
        (
          await service.list(
            requestLogQuerySchema.parse({ [field]: value.slice(0, -1) }),
          )
        ).total,
        0,
      );
      assert.equal(
        (
          await service.list(
            requestLogQuerySchema.parse({ [field]: "' OR 1=1 --" }),
          )
        ).total,
        0,
      );
    }
    assert.equal(
      (
        await service.list(
          requestLogQuerySchema.parse({
            threadId: records[1].threadId,
            userId: records[2].userId,
          }),
        )
      ).total,
      0,
    );
    const filteredFirst = await service.list(
      requestLogQuerySchema.parse({ threadId: records[4].threadId, limit: 1 }),
    );
    assert.equal(filteredFirst.total, 2);
    const filteredNext = await service.list(
      requestLogQuerySchema.parse({
        threadId: records[4].threadId,
        limit: 1,
        cursor: filteredFirst.nextCursor,
      }),
    );
    assert.equal(filteredNext.total, 2);
    assert.equal(filteredNext.items[0].id, records[4].id);
    assert.equal(filteredNext.nextCursor, null);
    await database.destroy();
    await database.initialize();
    const reopened = new RequestLogService(database);
    for (const record of records) {
      const detail = await reopened.get(record.id);
      assert.equal(detail.body, record.body);
      assert.equal(detail.bodyBytes, Buffer.byteLength(record.body));
      assert.equal(detail.status, record.complete ? 'complete' : 'incomplete');
      for (const field of requestLogContextFields)
        assert.equal(detail[field], record[field]);
      const response = responses.find((item) => item.id === record.id)!;
      for (const field of [
        'durationMs',
        'httpStatus',
        'responseStatus',
        'responseContentType',
        'responseContentEncoding',
        'responseBytes',
        'responseBody',
        'responseBodyEncoding',
      ] as const)
        assert.equal(detail[field], response[field]);
    }
    await assert.rejects(reopened.get(randomUUID()), { code: 'NOT_FOUND' });
  },
);
