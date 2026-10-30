import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalApiAccess } from '../apps/server/src/modules/auth/local-api.js';
import { createApp } from '../apps/server/src/app.js';
import { createNodeServer } from '../apps/server/src/server.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import type { RunInput } from '@aime/shared/threads';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';
import { generateLocalApiSpec } from '../apps/server/src/modules/local-api/catalog.js';
import { procedure } from '../packages/shared/src/rpc/base.js';
import { z } from 'zod';

const script = new URL(
  '../apps/server/src/mastra/skills/docs/scripts/app-api.mjs',
  import.meta.url,
);
const { callAppApi, createAppApi } = await import(script.href);
const origin = 'http://localhost:5173';

test('new opted-in contracts and schema changes work without editing the generic client', async () => {
  const contracts = (version: number) => ({
    reports: {
      inspect: procedure
        .meta({ localApi: true })
        .route({
          method: 'GET',
          path: `/v${version}/reports/{reportId}`,
          inputStructure: 'detailed',
          summary: '查找报告',
        })
        .input(
          z.object({
            params: z.object({ reportId: z.string() }),
            query: z.object({
              filters: z
                .object({ tags: z.array(z.string()), enabled: z.boolean() })
                .optional(),
              revision: z.coerce.number().default(version),
            }),
          }),
        )
        .output(z.object({ ok: z.boolean() })),
      update: procedure
        .meta({ localApi: true })
        .route({
          method: 'PATCH',
          path: `/v${version}/reports/{reportId}`,
          inputStructure: 'detailed',
        })
        .input(
          z.object({
            params: z.object({ reportId: z.string() }),
            body: z.object({
              note: z.string(),
              revision: z.number().default(version),
              ...(version > 1 ? { category: z.string().optional() } : {}),
            }),
          }),
        ),
      remove: procedure
        .meta({ localApi: true })
        .route({
          method: 'DELETE',
          path: '/reports/{reportId}',
          inputStructure: 'detailed',
          successStatus: 204,
        })
        .input(z.object({ params: z.object({ reportId: z.string() }) }))
        .output(z.void()),
      secret: procedure.route({ method: 'GET', path: '/secret' }),
    },
  });
  let spec = await generateLocalApiSpec(contracts(1));
  assert.equal(spec.paths?.['/secret'], undefined);
  const requests: Array<{ url: URL; options: RequestInit }> = [];
  const env = {
    APP_API_URL: 'http://127.0.0.1:3000/api',
    APP_API_TOKEN: 'test-token',
  };
  const fetchImpl = async (url: URL, options: RequestInit) => {
    if (url.pathname === '/api/local-api/openapi.json')
      return Response.json(spec);
    requests.push({ url, options });
    return options.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json({ ok: true });
  };
  const client = createAppApi({ env, fetchImpl });
  assert.equal((await client.list('报告'))[0].operationId, 'reports.inspect');
  const description = await client.describe('reports.update');
  assert.deepEqual(
    description.requestBody.content['application/json'].schema.required,
    ['note'],
  );
  assert.equal(
    description.requestBody.content['application/json'].schema.properties
      .revision.default,
    1,
  );
  await client.call('reports.inspect', {
    params: { reportId: '报告 1' },
    query: { filters: { tags: ['a', 'b'], enabled: false } },
  });
  assert.equal(decodeURI(requests[0].url.pathname), '/api/v1/reports/报告 1');
  assert.equal(requests[0].url.searchParams.get('filters[tags][1]'), 'b');
  assert.equal(requests[0].url.searchParams.get('filters[enabled]'), 'false');
  await client.call('reports.update', {
    params: { reportId: 'r1' },
    body: { note: 'A new field is accepted automatically', revision: 3 },
  });
  assert.equal(requests[1].options.method, 'PATCH');
  assert.equal(JSON.parse(String(requests[1].options.body)).revision, 3);
  assert.equal(
    await client.call('reports.remove', { params: { reportId: 'r1' } }),
    null,
  );
  const count = requests.length;
  await assert.rejects(client.call('reports.secret'), /未开放/);
  await assert.rejects(
    client.call('reports.inspect', { params: { reportId: '..' } }),
    /格式/,
  );
  await assert.rejects(
    client.call('reports.inspect', {
      params: { reportId: 'r1' },
      query: { unsupported: 1 },
    }),
    /未知 query/,
  );
  await assert.rejects(
    client.call('reports.update', { params: { reportId: 'r1' } }),
    /需要 body/,
  );
  assert.equal(requests.length, count);

  spec = await generateLocalApiSpec(contracts(2));
  const current = createAppApi({ env, fetchImpl });
  assert.equal(
    (await current.describe('reports.update')).requestBody.content[
      'application/json'
    ].schema.properties.revision.default,
    2,
  );
  await current.call('reports.inspect', {
    params: { reportId: 'r2' },
    query: { revision: 2 },
  });
  assert.equal(requests.at(-1)!.url.pathname, '/api/v2/reports/r2');
  assert.equal(
    (await current.describe('reports.update')).requestBody.content[
      'application/json'
    ].schema.properties.category.type,
    'string',
  );
  await current.call('reports.update', {
    params: { reportId: 'r2' },
    body: { note: 'updated', category: 'new-field' },
  });
  assert.equal(
    JSON.parse(String(requests.at(-1)!.options.body)).category,
    'new-field',
  );
});

test('local credentials expire, reject forgery, check active users and do not survive a restart', async () => {
  let now = 1000;
  const users = new Set(['alice', 'bob']);
  const api = new LocalApiAccess(
    'http://127.0.0.1:3000/api',
    async (id) => users.has(id),
    () => now,
  );
  const token = api.environment('alice').APP_API_TOKEN;
  const bob = api.environment('bob').APP_API_TOKEN;
  assert.notEqual(token, bob);
  assert.equal(await api.authenticate(`Bearer ${token}`), 'alice');
  assert.equal(await api.authenticate(`Bearer ${bob}`), 'bob');
  assert.equal(await api.authenticate(`Bearer ${token}x`), null);
  assert.equal(await api.authenticate(`Basic ${token}`), null);
  assert.deepEqual(api.environment(undefined), {});
  assert.deepEqual(api.environment('system'), {});
  users.delete('alice');
  assert.equal(await api.authenticate(`Bearer ${token}`), null);
  users.add('alice');
  const restarted = new LocalApiAccess(
    'http://127.0.0.1:3000/api',
    async () => true,
  );
  assert.equal(await restarted.authenticate(`Bearer ${token}`), null);
  now += 15 * 60_000;
  assert.equal(await api.authenticate(`Bearer ${token}`), null);
  assert.equal(
    await api.authenticate(`Bearer ${api.environment('alice').APP_API_TOKEN}`),
    'alice',
  );
});

test('skill scripts use existing APIs with scoped identity, ownership, paging and target settings', async (t) => {
  const root = await mkdtemp('/tmp/local-api-');
  const { memory } = fakeMemory();
  const sent: RunInput[] = [];
  const projectId = 'project000000001';
  const members = new Set(['alice']);
  let projectOwner: string | undefined;
  const projects = {
    async assertMember(userId: string, id: string) {
      if (id !== projectId || !members.has(userId))
        throw new ThreadError('PROJECT_NOT_FOUND', 404);
      return { role: 'owner' as const };
    },
    async create(userId: string, input: { name: string; workspace: unknown }) {
      projectOwner = userId;
      return { id: projectId, ...input, createdBy: userId };
    },
    async get(userId: string, id: string) {
      await this.assertMember(userId, id);
      return { id, name: 'Research', createdBy: projectOwner };
    },
    async list(userId: string, page: number) {
      return {
        projects: members.has(userId) ? [{ id: projectId }] : [],
        page,
        hasMore: false,
      };
    },
  };
  const threads = new ThreadService(
    memory,
    {
      async validate() {},
      async createWorkspace() {
        return root;
      },
      async open({ thread }) {
        return sessionStub({
          async send(input) {
            sent.push(input);
            await memory.saveMessages({
              messages: [
                {
                  id: input.id,
                  threadId: thread.id,
                  resourceId: thread.resourceId!,
                  role: 'user',
                  createdAt: new Date(),
                  content: {
                    format: 2,
                    parts: input.parts.filter((part) => part.type === 'text'),
                  },
                },
              ],
            });
          },
        });
      },
    },
    { assertMember: projects.assertMember },
  );
  let active = true;
  const localApi = new LocalApiAccess(
    'http://127.0.0.1:3000/api',
    async () => active,
  );
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.get('cookie') === 'browser=valid'
          ? {
              user: { id: 'alice', role: 'admin' },
              session: { id: 'browser-session' },
            }
          : null,
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads,
    projects,
    localApi,
    webOrigin: origin,
  } as unknown as NonNullable<Parameters<typeof createApp>[2]>);
  const env = localApi.environment('alice');
  const fetchImpl = (url: URL, options: RequestInit) =>
    app.request(url.href, options);
  const call = (command: string, input = {}, environment = env) =>
    callAppApi(command, input, { env: environment, fetchImpl });
  t.after(async () => {
    await threads.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal((await app.request('/api/threads')).status, 401);
  assert.equal((await app.request('/api/local-api/openapi.json')).status, 401);
  assert.equal(
    (
      await app.request('/api/local-api/openapi.json', {
        headers: { cookie: 'browser=valid' },
      })
    ).status,
    401,
  );
  const client = createAppApi({ env, fetchImpl });
  const catalog = await client.list();
  assert.equal(catalog.length, 14);
  assert.equal((await client.list('personalEnvironmentVariables')).length, 5);
  assert.ok(
    catalog.some(
      (operation: { operationId: string }) =>
        operation.operationId === 'threads.run',
    ),
  );
  assert.ok(
    !(await client.list()).some(
      (operation: { operationId: string }) =>
        operation.operationId === 'threads.remove',
    ),
  );
  assert.equal((await client.list('项目')).length, 4);
  const description = await client.describe('projects.create');
  assert.deepEqual(
    description.requestBody.content['application/json'].schema.required,
    ['name'],
  );
  assert.deepEqual(
    description.requestBody.content['application/json'].schema.properties
      .workspace.default,
    { mode: 'simple', provider: 'local' },
  );
  await assert.rejects(client.describe('threads.remove'), /未开放/);
  const project = await call('projects.create', { body: { name: 'Research' } });
  assert.equal(project.createdBy, 'alice');
  assert.deepEqual(project.workspace, { mode: 'simple', provider: 'local' });
  assert.equal(
    (await call('projects.list', { query: { page: 0 } })).projects[0].id,
    projectId,
  );
  assert.equal(
    (await call('projects.get', { params: { projectId } })).name,
    'Research',
  );
  const thread = await call('threads.create', {
    body: {
      title: 'Analysis',
      model: 'provider/model',
      reasoningEffort: 'high',
    },
  });
  const shared = await call('threads.create', {
    body: { title: 'Shared', projectId },
  });
  assert.equal(thread.createdBy, 'alice');
  const firstPage = await call('threads.list', {
    query: { page: 0, perPage: 1 },
  });
  assert.equal(firstPage.threads.length, 1);
  assert.equal(firstPage.threads[0].id, thread.id);
  assert.equal(
    (await call('threads.list', { query: { projectId } })).threads[0].id,
    shared.id,
  );
  const target = (
    await call('threads.get', { params: { threadId: thread.id } })
  ).thread;
  assert.equal(target.model, 'provider/model');
  const messageId = 'message-001';
  const message = {
    id: messageId,
    parts: [{ type: 'text', text: 'Hello\n世界' }],
    model: target.model,
    agentId: target.agentId,
    reasoningEffort: target.reasoningEffort,
    createdBy: 'bob',
  };
  const submitted = await call('threads.run', {
    params: { threadId: thread.id },
    body: message,
  });
  assert.equal(submitted.id, thread.id);
  assert.equal(sent[0].createdBy, 'alice');
  assert.equal(sent[0].model, 'provider/model');
  assert.equal(sent[0].reasoningEffort, 'high');
  assert.equal(sent[0].id, messageId);
  assert.deepEqual(sent[0].parts, [{ type: 'text', text: 'Hello\n世界' }]);
  const history = await call('threads.history', {
    params: { threadId: thread.id },
    query: { page: 0 },
  });
  assert.equal(history.messages[0].id, messageId);
  assert.ok(history.anchor);
  const summary = await call('threads.history', {
    params: { threadId: thread.id },
    query: { view: 'summary' },
  });
  assert.ok(Array.isArray(summary.turns));
  if (summary.turns.length) {
    const detail = await call('threads.turn', {
      params: {
        threadId: thread.id,
        turnId: summary.turns[0].id,
      },
    });
    assert.ok(detail);
  }
  const bobEnv = localApi.environment('bob');
  assert.deepEqual((await call('threads.list', {}, bobEnv)).threads, []);
  for (const command of ['threads.get', 'threads.history'])
    await assert.rejects(
      call(command, { params: { threadId: thread.id } }, bobEnv),
      /404/,
    );
  await assert.rejects(
    call(
      'threads.run',
      { params: { threadId: thread.id }, body: message },
      bobEnv,
    ),
    /404/,
  );
  await assert.rejects(
    call('threads.list', { query: { projectId } }, bobEnv),
    /404/,
  );
  members.clear();
  await assert.rejects(
    call('threads.get', { params: { threadId: shared.id } }),
    /404/,
  );
  members.add('alice');

  // Token scopes apply to both HTTP and RPC even for an administrator's browser cookie.
  const headers = {
    authorization: `Bearer ${env.APP_API_TOKEN}`,
    cookie: 'browser=valid',
    origin,
    'content-type': 'application/json',
  };
  for (const [path, method] of [
    ['/api/threads/' + thread.id, 'DELETE'],
    ['/api/admin/providers', 'GET'],
    ['/api/rpc/notifications/config', 'POST'],
    ['/api/rpc/environmentVariables/list', 'POST'],
  ]) {
    const response = await app.request(path, {
      method,
      headers,
      ...(method === 'POST' ? { body: '{"json":{}}' } : {}),
    });
    assert.equal(response.status, 403, path);
  }
  assert.equal(
    (
      await app.request('/api/rpc/threads/list', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ json: { query: {} } }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request('/api/threads', {
        headers: { cookie: 'browser=valid', authorization: 'Bearer invalid' },
      })
    ).status,
    401,
  );
  active = false;
  await assert.rejects(call('threads.list'), /401/);
  // The cached catalog must not bypass authorization on API requests.
  await assert.rejects(client.call('threads.list'), /401/);
  active = true;
  assert.equal(
    (
      await app.request('/api/threads', {
        method: 'POST',
        headers: {
          cookie: 'browser=valid',
          'content-type': 'application/json',
        },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request('/api/threads', {
        method: 'POST',
        headers: {
          cookie: 'browser=valid',
          origin,
          'content-type': 'application/json',
        },
        body: '{}',
      })
    ).status,
    201,
  );

  // Exercise the executable CLI over an actual loopback HTTP server, with a JSON file.
  const server = createNodeServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const inputFile = join(root, 'input.json');
  await writeFile(
    inputFile,
    JSON.stringify({
      params: { threadId: thread.id },
      body: {
        ...message,
        id: 'cli-message-001',
        parts: [{ type: 'text', text: 'CLI message\nwith "quotes"' }],
      },
    }),
  );
  const output = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(script), 'call', 'threads.run', '--file', inputFile],
    {
      env: {
        PATH: process.env.PATH,
        ...env,
        APP_API_URL: `http://127.0.0.1:${address.port}/api`,
      },
    },
  );
  assert.equal(JSON.parse(output.stdout).id, thread.id);
  assert.equal(output.stderr, '');
  assert.ok(!output.stdout.includes(env.APP_API_TOKEN));
});

test('script rejects credential destinations and redirects, sanitizes errors and honors abort', async () => {
  const env = {
    APP_API_URL: 'http://127.0.0.1:3000/api',
    APP_API_TOKEN: 'private-test-token',
  };
  let called = false;
  const fetchImpl = async (_url: URL, options: RequestInit) => {
    called = true;
    assert.equal(options.redirect, 'error');
    return new Response(
      JSON.stringify({ code: 'UNAUTHORIZED', message: env.APP_API_TOKEN }),
      { status: 401 },
    );
  };
  for (const url of [
    'https://example.com/api',
    'http://127.0.0.1:3000/api?secret=yes',
    'http://user@127.0.0.1:3000/api',
    'http://127.0.0.1:3000/not-api',
  ])
    await assert.rejects(
      callAppApi(
        'threads.list',
        {},
        { env: { ...env, APP_API_URL: url }, fetchImpl },
      ),
      /APP_API_URL/,
    );
  assert.equal(called, false);
  await assert.rejects(
    callAppApi('threads.list', {}, { env, fetchImpl }),
    (error: Error) =>
      /401/.test(error.message) && !error.message.includes(env.APP_API_TOKEN),
  );
  await assert.rejects(
    callAppApi('threads.list', {}, { env: {} }),
    /缺少应用认证环境/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    callAppApi(
      'threads.list',
      {},
      {
        env,
        signal: controller.signal,
        fetchImpl: async () => {
          throw new Error('abort');
        },
      },
    ),
    /用户中止了操作/,
  );
});
