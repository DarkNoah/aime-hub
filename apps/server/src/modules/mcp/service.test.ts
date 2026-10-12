import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import type { createExecTool } from '../../mastra/tools/exec.js';
import { isValidationError, noopObserve } from '@mastra/core/tools';
import type { DataSource } from 'typeorm';
import type { McpInput } from '@aime/shared/mcp';
import { McpService } from './service.js';
import { createMcpClient, toMastraServer } from './client.js';
import { ToolService } from '../tools/service.js';
import type { ProviderService } from '../providers/service.js';
import { buildAgent } from '../../mastra/agents/factory.js';
import { fallbackAgentId, getCodeAgent } from '../../mastra/agents/index.js';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createApp } from '../../app.js';
import { createApiClient } from '../../../../web/src/lib/rpc.js';

const input: McpInput = {
  name: 'local',
  config: {
    command: 'node',
    args: ['server.js'],
    env: { API_KEY: 'secret=1' },
  },
};
const toolDefinition = {
  name: 'read',
  description: 'Read fixture',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
};

async function fixture() {
  const store = (await new InMemoryStore().getStore('mcpClients'))!;
  const instances: {
    closed: number;
    discoveries: number;
    runs: number;
    fail: boolean;
    catalogReads: number;
    emptyCatalog: boolean;
  }[] = [];
  let failNext = false;
  let pendingDiscovery: Promise<void> | undefined;
  const factory: typeof createMcpClient = (servers) => {
    const state = {
      closed: 0,
      discoveries: 0,
      runs: 0,
      fail: failNext,
      catalogReads: 0,
      emptyCatalog: false,
    };
    failNext = false;
    instances.push(state);
    return {
      async listToolDefinitionsWithErrors() {
        state.catalogReads++;
        await pendingDiscovery;
        return {
          definitions: {
            [servers[0].name]: state.emptyCatalog
              ? {}
              : {
                  read: {
                    ...toolDefinition,
                    server: {
                      name: servers[0].name,
                      instructions: 'not part of admin response',
                    },
                    _meta: { private: 'not part of admin response' },
                  },
                },
          },
          errors: state.fail
            ? { remote: 'secret credentials must not escape' }
            : {},
          errorDetails: {},
        };
      },
      async listToolsWithErrors() {
        state.discoveries++;
        await pendingDiscovery;
        return {
          tools: {
            [`${servers[0].name}_read`]: createTool({
              id: 'read',
              description: 'Read fixture',
              execute: async () => {
                state.runs++;
                return { ok: true };
              },
            }),
          },
          errors: state.fail
            ? { remote: 'secret credentials must not escape' }
            : {},
          errorDetails: {},
        };
      },
      async disconnect() {
        state.closed++;
      },
    } as unknown as ReturnType<typeof createMcpClient>;
  };
  const service = new McpService(store, factory);
  const create = async (value = input) =>
    (await service.create('admin', { servers: [value] }))[0];
  return {
    store,
    service,
    instances,
    create,
    factory,
    failNext: () => {
      failNext = true;
    },
    block: (promise: Promise<void>) => {
      pendingDiscovery = promise;
    },
  };
}

test('native MCP client metadata stores complete config without type and isolates unrelated records', async () => {
  const f = await fixture();
  const row = await f.create();
  assert.equal(row.status, 'draft');
  assert.deepEqual(row.config, input.config);
  const stored = (await f.store.getById(row.id))!;
  assert.equal(stored.authorId, 'admin');
  assert.equal('type' in stored.metadata!, false);
  assert.equal('type' in (stored.metadata!.config as object), false);
  assert.deepEqual((await f.store.getLatestVersion(row.id))!.servers, {});
  await f.store.create({
    mcpClient: { id: 'external', name: 'external', servers: {} },
  });
  assert.deepEqual(
    (await f.service.list()).map((item) => item.id),
    [row.id],
  );
  await assert.rejects(f.service.get('external'), { code: 'MCP_NOT_FOUND' });
  await assert.rejects(f.service.remove('external', row.revision), {
    code: 'MCP_NOT_FOUND',
  });
  await assert.rejects(f.service.create('admin', { servers: [input] }), {
    code: 'MCP_NAME_CONFLICT',
  });
  await f.service.remove(row.id, row.revision);
  assert.equal(await f.store.getById(row.id), null);
  assert.equal(await f.store.countVersions(row.id), 0);
});

test('tool catalog uses the resident native client, preserves schemas and enforces publication', async (t) => {
  const f = await fixture();
  t.after(() => f.service.shutdown());
  const row = await f.create();
  await assert.rejects(f.service.listTools(row.id), {
    code: 'MCP_NOT_PUBLISHED',
  });
  assert.equal(f.instances.length, 0);
  const published = await f.service.setStatus(row.id, {
    status: 'published',
    revision: row.revision,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await f.service.listTools(row.id))),
    [toolDefinition],
  );
  assert.deepEqual(await f.service.listTools(row.id), [toolDefinition]);
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].catalogReads, 2);
  assert.equal(f.instances[0].discoveries, 1);
  f.instances[0].fail = true;
  await assert.rejects(f.service.listTools(row.id), {
    code: 'MCP_CONNECTION_FAILED',
    message: 'MCP_CONNECTION_FAILED',
  });
  assert.equal(f.instances[0].closed, 0);
  f.instances[0].fail = false;
  f.instances[0].emptyCatalog = true;
  assert.deepEqual(await f.service.listTools(row.id), []);
  const restarted = new McpService(f.store, f.factory);
  t.after(() => restarted.shutdown());
  await assert.rejects(restarted.listTools(row.id), {
    code: 'MCP_UNAVAILABLE',
  });
  assert.equal(f.instances.length, 1);
  await f.service.setStatus(row.id, {
    status: 'draft',
    revision: published.revision,
  });
  await assert.rejects(f.service.listTools(row.id), {
    code: 'MCP_NOT_PUBLISHED',
  });
});

test('unpublish waits for a catalog read and then closes the resident connection', async (t) => {
  const f = await fixture();
  t.after(() => f.service.shutdown());
  const row = await f.create();
  const published = await f.service.setStatus(row.id, {
    status: 'published',
    revision: row.revision,
  });
  let unblock!: () => void;
  f.block(
    new Promise<void>((resolve) => {
      unblock = resolve;
    }),
  );
  const reading = f.service.listTools(row.id);
  await new Promise((resolve) => setImmediate(resolve));
  const unpublishing = f.service.setStatus(row.id, {
    status: 'draft',
    revision: published.revision,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.instances[0].closed, 0);
  assert.equal(Object.keys(await f.service.getTools()).length, 1);
  unblock();
  assert.deepEqual(await reading, [toolDefinition]);
  await unpublishing;
  assert.equal(f.instances[0].closed, 1);
  await assert.rejects(f.service.listTools(row.id), {
    code: 'MCP_NOT_PUBLISHED',
  });
});

test('publishing awaits real discovery; failed discovery keeps draft and releases candidate', async () => {
  const f = await fixture();
  const row = await f.create();
  f.failNext();
  await assert.rejects(
    f.service.setStatus(row.id, {
      status: 'published',
      revision: row.revision,
    }),
    { code: 'MCP_CONNECTION_FAILED', message: 'MCP_CONNECTION_FAILED' },
  );
  assert.equal((await f.service.get(row.id)).status, 'draft');
  assert.equal((await f.service.get(row.id)).revision, row.revision);
  assert.equal(f.instances[0].closed, 1);
  let unblock!: () => void;
  f.block(
    new Promise<void>((resolve) => {
      unblock = resolve;
    }),
  );
  const publishing = f.service.setStatus(row.id, {
    status: 'published',
    revision: row.revision,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.service.get(row.id)).status, 'draft');
  unblock();
  const published = await publishing;
  assert.equal(published.status, 'published');
  assert.equal(
    (await f.store.getById(row.id))!.activeVersionId,
    (await f.store.getLatestVersion(row.id))!.id,
  );
  assert.equal(f.instances[1].closed, 0);
  await f.service.shutdown();
});

test('Agent construction excludes MCP tools; exec discovers resident tools and respects unpublishing', async (t) => {
  const f = await fixture();
  const row = await f.create();
  assert.deepEqual(await f.service.getTools(), {});
  assert.equal(f.instances.length, 0);
  const published = await f.service.setStatus(row.id, {
    status: 'published',
    revision: row.revision,
  });
  const mcpReads = t.mock.method(f.service, 'getTools');
  const tools = new ToolService(
    {
      getRepository: () => ({ findOneBy: async () => null }),
    } as unknown as DataSource,
    {} as ProviderService,
    undefined,
    f.service,
  );
  const config = { ...getCodeAgent(fallbackAgentId)!, tools: [] };
  const options = {
    model: new MastraLanguageModelV2Mock({}),
    buildTools: tools.buildTools.bind(tools),
  };
  const agents = [
    buildAgent(config, options),
    buildAgent({ ...config, tools: ['exec'] }, options),
    buildAgent({ ...config, tools: ['curr_time'] }, options),
  ];
  const maps = await Promise.all(agents.map((agent) => agent.listTools()));
  assert.deepEqual(
    maps.map((tools) => Object.keys(tools)),
    [[], ['exec'], ['curr_time']],
  );
  assert.equal(mcpReads.mock.callCount(), 0);
  const mcp = await f.service.getTools();
  const name = Object.keys(mcp)[0];
  assert.equal(name, 'mcp__local__read');
  assert.equal(name.length <= 64, true);
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].discoveries, 1);
  const handle = mcp[name];
  await handle.execute!({}, {} as never);
  assert.equal(f.instances[0].runs, 1);
  const exec = maps[1].exec as ReturnType<typeof createExecTool>;
  const run = () =>
    exec.execute!(
      {
        code: `text(ALL_TOOLS.filter(t => t.name.startsWith('mcp__'))); text(await tools.${name}({}));`,
        yield_time_ms: 3000,
        max_output_tokens: 1000,
      },
      { observe: noopObserve },
    );
  const composed = await run();
  assert.ok(composed && !isValidationError(composed) && !composed.isError);
  assert.equal(f.instances[0].runs, 2);
  const draft = await f.service.setStatus(row.id, {
    status: 'draft',
    revision: published.revision,
  });
  assert.equal(f.instances[0].closed, 1);
  assert.deepEqual(await f.service.getTools(), {});
  const unavailable = await run();
  assert.ok(
    unavailable && !isValidationError(unavailable) && unavailable.isError,
  );
  assert.deepEqual(unavailable.content[0], { type: 'text', text: '[]' });
  assert.equal(f.instances[0].runs, 2);
  await assert.rejects(handle.execute!({}, {} as never), {
    code: 'MCP_NOT_PUBLISHED',
  });
  await assert.rejects(f.service.testConnection(row.id), {
    code: 'MCP_NOT_PUBLISHED',
  });
  await f.service.remove(row.id, draft.revision);
});

test('published edits validate candidates, preserve old connections on failure, then replace and reject stale writes', async () => {
  const f = await fixture();
  const row = await f.create();
  const published = await f.service.setStatus(row.id, {
    status: 'published',
    revision: row.revision,
  });
  const oldHandle = Object.values(await f.service.getTools())[0];
  const update = {
    name: 'remote',
    config: {
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer secret' },
    },
    revision: published.revision,
  };
  f.failNext();
  await assert.rejects(f.service.update(row.id, update), {
    code: 'MCP_CONNECTION_FAILED',
  });
  assert.deepEqual((await f.service.get(row.id)).config, input.config);
  assert.equal(f.instances[0].closed, 0);
  const changed = await f.service.update(row.id, update);
  assert.equal(changed.status, 'published');
  assert.deepEqual(changed.config, update.config);
  assert.equal(f.instances[0].closed, 1);
  assert.equal(f.instances[2].closed, 0);
  await assert.rejects(oldHandle.execute!({}, {} as never), {
    code: 'MCP_CONFLICT',
  });
  await assert.rejects(f.service.update(row.id, update), {
    code: 'MCP_CONFLICT',
  });
  await assert.rejects(f.service.remove(row.id, published.revision), {
    code: 'MCP_CONFLICT',
  });
  await f.service.remove(row.id, changed.revision);
  assert.equal(f.instances[2].closed, 1);
});

test('startup restores only published clients and shutdown disconnects them', async () => {
  const f = await fixture();
  const row = await f.create();
  await f.create({ name: 'draft', config: { command: 'node' } });
  await f.service.setStatus(row.id, {
    status: 'published',
    revision: row.revision,
  });
  await f.service.shutdown();
  const restarted = new McpService(f.store, f.factory);
  assert.deepEqual(await restarted.initialize(), { connected: 1, failed: 0 });
  assert.equal(f.instances.length, 2);
  await restarted.initialize();
  await restarted.getTools();
  await restarted.testConnection(row.id);
  assert.equal(f.instances.length, 2);
  await restarted.shutdown();
  assert.equal(f.instances[1].closed, 1);
  await assert.rejects(restarted.getTools(), { code: 'MCP_UNAVAILABLE' });
});

test('slow publication checks do not block chats from reading resident tools', async () => {
  const f = await fixture();
  const first = await f.create();
  await f.service.setStatus(first.id, {
    status: 'published',
    revision: first.revision,
  });
  const second = await f.create({ ...input, name: 'second' });
  let release!: () => void;
  f.block(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const publishing = f.service.setStatus(second.id, {
    status: 'published',
    revision: second.revision,
  });
  await new Promise((resolve) => setImmediate(resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tools = await Promise.race([
      f.service.getTools(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 200);
      }),
    ]);
    assert.ok(
      tools,
      'chat tools should be returned before the candidate finishes discovery',
    );
    assert.equal(Object.keys(tools).length, 1);
    assert.equal(f.instances.length, 2);
  } finally {
    clearTimeout(timer);
    release();
    await publishing;
    await f.service.shutdown();
  }
});

test('native update failure closes the new candidate and leaves the old client in place', async (t) => {
  const f = await fixture();
  const row = await f.create();
  t.mock.method(f.store, 'update', async () => {
    throw new Error('database write failed');
  });
  await assert.rejects(
    f.service.setStatus(row.id, {
      status: 'published',
      revision: row.revision,
    }),
  );
  assert.equal((await f.service.get(row.id)).status, 'draft');
  assert.equal(f.instances[0].closed, 1);
});

test('batch creation rolls back previous records when a later native create fails', async (t) => {
  const f = await fixture();
  const create = f.store.create.bind(f.store);
  let count = 0;
  t.mock.method(
    f.store,
    'create',
    async (value: Parameters<typeof create>[0]) => {
      if (++count === 2) throw new Error('fixture write failure');
      return create(value);
    },
  );
  await assert.rejects(
    f.service.create('admin', {
      servers: [input, { ...input, name: 'second' }],
    }),
  );
  assert.deepEqual(await f.service.list(), []);
});

test('native HTTP adapter forwards credentials to SSE GET and preserves protocol headers', async (t) => {
  let sent: Headers | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response('{}');
    },
  );
  const definition = toMastraServer({
    name: 'remote',
    config: {
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer a=b==' },
    },
  });
  assert.ok(definition.url instanceof URL);
  await definition.fetch!('https://example.com/sse', {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(sent?.get('Authorization'), 'Bearer a=b==');
  assert.equal(sent?.get('Accept'), 'text/event-stream');
});

test('admin HTTP and typed RPC enforce session, exact role, origin, validation and publication', async (t) => {
  const f = await fixture();
  const origin = 'http://localhost:5173';
  let user: { id: string; role: string } | undefined;
  let requestOrigin = origin;
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof createApp>[0];
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
    { service: f.service, webOrigin: origin },
  );
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set('Origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });
  const id = randomUUID(),
    revision = randomUUID();
  const calls = [
    () => client.mcp.list(),
    () => client.mcp.get({ params: { id } }),
    () => client.mcp.tools({ params: { id } }),
    () => client.mcp.create({ body: { servers: [input] } }),
    () => client.mcp.update({ params: { id }, body: { ...input, revision } }),
    () =>
      client.mcp.status({
        params: { id },
        body: { status: 'published', revision },
      }),
    () => client.mcp.test({ params: { id } }),
    () => client.mcp.remove({ params: { id }, query: { revision } }),
  ];
  for (const role of [undefined, 'user', 'admin-assistant']) {
    user = role ? { id: 'tester', role } : undefined;
    for (const call of calls)
      await assert.rejects(call(), {
        code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
      });
    const result = await app.request('/api/admin/mcp', {
      headers: { Origin: origin },
    });
    assert.equal(result.status, role ? 403 : 401);
  }
  user = { id: 'admin', role: 'admin' };
  requestOrigin = 'https://other.example';
  for (const call of calls.slice(3))
    await assert.rejects(call(), { code: 'FORBIDDEN' });
  requestOrigin = origin;
  const response = await app.request('/api/admin/mcp', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      servers: [
        { name: 'bad', config: { command: 'npx', url: 'http://localhost' } },
      ],
    }),
  });
  assert.equal(response.status, 400);
  const [row] = await client.mcp.create({ body: { servers: [input] } });
  await assert.rejects(client.mcp.test({ params: { id: row.id } }), {
    code: 'MCP_NOT_PUBLISHED',
  });
  await assert.rejects(client.mcp.tools({ params: { id: row.id } }), {
    code: 'MCP_NOT_PUBLISHED',
  });
  const published = await client.mcp.status({
    params: { id: row.id },
    body: { status: 'published', revision: row.revision },
  });
  assert.deepEqual(await client.mcp.test({ params: { id: row.id } }), {
    toolCount: 1,
  });
  assert.deepEqual(await client.mcp.tools({ params: { id: row.id } }), [
    toolDefinition,
  ]);
  const catalogResponse = await app.request(`/api/admin/mcp/${row.id}/tools`);
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual(await catalogResponse.json(), [toolDefinition]);
  await client.mcp.remove({
    params: { id: row.id },
    query: { revision: published.revision },
  });
  assert.deepEqual(await client.mcp.list(), []);
});

test('MCP names have no suffix and normalization conflicts never overwrite another server tool', async () => {
  const f = await fixture();
  for (const name of ['read-server', 'read_server']) {
    const row = await f.create({ ...input, name });
    await f.service.setStatus(row.id, {
      status: 'published',
      revision: row.revision,
    });
  }
  await assert.rejects(f.service.getTools(), { code: 'MCP_NAME_CONFLICT' });
  assert.deepEqual(
    f.instances.map((instance) => instance.runs),
    [0, 0],
  );
  await f.service.shutdown();
});
