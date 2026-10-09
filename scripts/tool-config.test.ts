import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createDataSource } from '@aime/db';
import {
  defaultWebSearchConfig,
  defaultWebFetchConfig,
  webFetchConfigSchema,
  webSearchConfigSchema,
} from '@aime/shared/tools';
import { ToolService } from '../apps/server/src/modules/tools/service.js';
import type { ProviderService } from '../apps/server/src/modules/providers/service.js';
import { SerpApiProvider } from '../apps/server/src/mastra/providers/serpapi.js';
import { SogouProvider } from '../apps/server/src/mastra/providers/sogou.js';
import { createApp } from '../apps/server/src/app.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';

const provider = {
  id: 'search-provider',
  type: 'serpapi',
  name: 'Search',
  enabled: true,
  apiKey: 'synthetic-secret',
  baseUrl: 'https://serpapi.com',
  metadata: {},
  models: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};
function fixture() {
  const rows = new Map<string, { id: string; value: unknown }>();
  const database = {
    getRepository: () => ({
      async findOneBy({ id }: { id: string }) {
        return rows.get(id) ?? null;
      },
      async upsert(row: { id: string; value: unknown }) {
        rows.set(row.id, structuredClone(row));
      },
    }),
  } as unknown as DataSource;
  let current = { ...provider };
  const providers: Pick<ProviderService, 'getProvider'> = {
    async getProvider(id) {
      assert.equal(id, provider.id);
      return current;
    },
  };
  return {
    rows,
    database,
    providers,
    setProvider: (value: typeof provider) => {
      current = value;
    },
    service: new ToolService(database, providers),
  };
}

test('web search configuration validates limits, unknown properties and defaults', () => {
  assert.deepEqual(webSearchConfigSchema.parse({}), defaultWebSearchConfig);
  for (const patch of [
    { numResults: 0 },
    { numResults: 21 },
    { numResults: 1.5 },
    { timeoutMs: 0 },
    { timeoutMs: 60001 },
    { providerId: '' },
    { apiKey: 'should-never-be-here' },
    { provider: 'unknown' },
  ]) {
    assert.equal(
      webSearchConfigSchema.safeParse({ ...defaultWebSearchConfig, ...patch })
        .success,
      false,
    );
  }
});

test('persisted configuration controls new tool instances, without credentials in tool settings or results', async (t) => {
  const f = fixture();
  assert.deepEqual(await f.service.list(), [
    { id: 'web_search', config: defaultWebSearchConfig },
    { id: 'web_fetch', config: defaultWebFetchConfig },
  ]);
  const saved = {
    ...defaultWebSearchConfig,
    providerId: provider.id,
    numResults: 2,
    timeoutMs: 4321,
  };
  await f.service.update('web_search', saved);
  assert.doesNotMatch(
    JSON.stringify([...f.rows.values()]),
    /synthetic-secret|apiKey/,
  );
  const restored = new ToolService(f.database, f.providers);
  assert.deepEqual((await restored.get('web_search')).config, saved);
  t.mock.method(
    SerpApiProvider.prototype,
    'webSearch',
    async (input: { numResults: number }) => {
      assert.equal(input.numResults, 2);
      return [{ title: 'Result', href: 'https://example.com' }];
    },
  );
  const first = (await restored.createTools()).web_search;
  assert.ok('execute' in first && first.execute);
  const output = await first.execute({ query: 'query' }, {});
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret/);
  await restored.update('web_search', { ...saved, enabled: false });
  assert.deepEqual(Object.keys(await restored.createTools()), ['web_fetch']);
  await restored.update('web_search', { ...saved, enabled: true });
  const next = (await restored.createTools()).web_search;
  assert.notEqual(next, first);
});

test('only enabled SerpAPI credentials can be selected; later disable/removal triggers fallback at execution', async (t) => {
  const f = fixture();
  const config = { ...defaultWebSearchConfig, providerId: provider.id };
  for (const patch of [
    { type: 'openai' },
    { type: 'mineru' },
    { enabled: false },
    { apiKey: '' },
  ]) {
    f.setProvider({ ...provider, ...patch });
    await assert.rejects(f.service.update('web_search', config), {
      code: 'INVALID_TOOL_PROVIDER',
    });
    assert.equal(f.rows.size, 0);
  }
  f.setProvider({ ...provider });
  await f.service.update('web_search', config);
  const tool = (await f.service.createTools()).web_search;
  assert.ok('execute' in tool && tool.execute);
  t.mock.method(SogouProvider.prototype, 'webSearch', async () => [
    { title: 'Fallback', href: 'https://example.com/' },
  ]);
  f.setProvider({ ...provider, enabled: false });
  assert.equal((await tool.execute({ query: 'query' }, {})).provider, 'sogou');
  t.mock.method(f.providers, 'getProvider', async () => {
    throw new Error('deleted');
  });
  assert.equal((await tool.execute({ query: 'query' }, {})).provider, 'sogou');
  await f.service.update('web_search', { ...config, enabled: false });
  assert.deepEqual(Object.keys(await f.service.createTools()), ['web_fetch']);
});

test('tool settings HTTP and RPC enforce admin, origin and schema validation', async (t) => {
  const f = fixture();
  const origin = 'http://localhost:5173';
  let role: string | undefined;
  let requestOrigin: string | undefined = origin;
  const auth = {
    api: {
      getSession: async () => (role ? { user: { id: 'tester', role } } : null),
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(
    auth,
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
    if (requestOrigin) headers.set('Origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });
  const body = { ...defaultWebSearchConfig, providerId: provider.id };
  const update = () =>
    client.tools.update({ params: { toolId: 'web_search' }, body });
  for (const value of [undefined, 'user', 'admin-assistant']) {
    role = value;
    for (const call of [() => client.tools.list(), update])
      await assert.rejects(call(), {
        code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
      });
    assert.equal(
      (await app.request('/api/admin/tools')).status,
      role ? 403 : 401,
    );
    assert.equal(
      (
        await app.request('/api/admin/tools/web_search', {
          method: 'PUT',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
      role ? 403 : 401,
    );
  }
  role = 'admin';
  for (const value of [undefined, 'https://other.example']) {
    requestOrigin = value;
    await assert.rejects(update(), { code: 'FORBIDDEN' });
  }
  assert.equal(f.rows.size, 0);
  requestOrigin = origin;
  await assert.rejects(
    client.tools.update({
      params: { toolId: 'web_search' },
      body: { ...body, numResults: 30 },
    }),
    { code: 'VALIDATION_ERROR' },
  );
  const invalid = await app.request('/api/admin/tools/not-a-tool', {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await update(), { id: 'web_search', config: body });
  assert.deepEqual(await client.tools.list(), [
    { id: 'web_search', config: body },
    { id: 'web_fetch', config: defaultWebFetchConfig },
  ]);
  const fetchBody = { ...defaultWebFetchConfig, maxChars: 12345 };
  assert.deepEqual(
    await client.tools.update({
      params: { toolId: 'web_fetch' },
      body: fetchBody,
    }),
    { id: 'web_fetch', config: fetchBody },
  );
  const mismatch = await app.request('/api/admin/tools/web_fetch', {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(mismatch.status, 400);
  const response = await app.request('/api/admin/tools');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /synthetic-secret|apiKey/);
});

test('web fetch settings select only Jina AI credentials, persist limits and independently disable the tool', async () => {
  const f = fixture();
  for (const patch of [
    { maxChars: 999 },
    { maxChars: 200001 },
    { timeoutMs: 0 },
    { numResults: 3 },
  ])
    assert.equal(
      webFetchConfigSchema.safeParse({ ...defaultWebFetchConfig, ...patch })
        .success,
      false,
    );
  const config = {
    ...defaultWebFetchConfig,
    providerId: provider.id,
    maxChars: 2000,
  };
  await assert.rejects(f.service.update('web_fetch', config), {
    code: 'INVALID_TOOL_PROVIDER',
  });
  for (const patch of [{ apiKey: '' }, { enabled: false }]) {
    f.setProvider({ ...provider, type: 'jina-ai', ...patch });
    await assert.rejects(f.service.update('web_fetch', config), {
      code: 'INVALID_TOOL_PROVIDER',
    });
  }
  f.setProvider({ ...provider, type: 'jina-ai', baseUrl: 'https://r.jina.ai' });
  await f.service.update('web_fetch', config);
  assert.deepEqual(
    await new ToolService(f.database, f.providers).get('web_fetch'),
    { id: 'web_fetch', config },
  );
  assert.doesNotMatch(
    JSON.stringify([...f.rows.values()]),
    /synthetic-secret|apiKey/,
  );
  assert.ok((await f.service.createTools()).web_fetch);
  await f.service.update('web_fetch', { ...config, enabled: false });
  assert.deepEqual(Object.keys(await f.service.createTools()), ['web_search']);
});

test(
  'tool settings persist in the existing PostgreSQL settings table',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `tools_test_${randomBytes(8).toString('hex')}`;
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
    });
    t.after(async () => {
      if (database.isInitialized) await database.destroy();
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.end();
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.runMigrations();
    const service = new ToolService(database, fixture().providers);
    const config = { ...defaultWebSearchConfig, numResults: 7 };
    await service.update('web_search', config);
    await database.destroy();
    await database.initialize();
    assert.deepEqual(
      (await new ToolService(database, fixture().providers).get('web_search'))
        .config,
      config,
    );
  },
);
