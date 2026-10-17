import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createDataSource } from '@aime/db';
import {
  toolIds,
  defaultWebSearchConfig,
  defaultWebFetchConfig,
  defaultImageGenConfig,
  defaultSpeechConfig,
  defaultTranscribeConfig,
  defaultViewFileConfig,
  webFetchConfigSchema,
  webSearchConfigSchema,
} from '@aime/shared/tools';
import {
  buildTools,
  registeredToolIds,
  ToolService,
  type RegisteredToolId,
} from '../apps/server/src/modules/tools/service.js';
import { SerpApiProvider } from '../apps/server/src/mastra/providers/serpapi.js';
import { LocalProvider } from '../apps/server/src/mastra/providers/local.js';
import { PaddleOCRProvider } from '../apps/server/src/mastra/providers/paddleocr.js';
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
  const reads: string[] = [];
  const database = {
    getRepository: () => ({
      async findOneBy({ id }: { id: string }) {
        reads.push(id);
        return rows.get(id) ?? null;
      },
      async upsert(row: { id: string; value: unknown }) {
        rows.set(row.id, structuredClone(row));
      },
    }),
  } as unknown as DataSource;
  let current = { ...provider };
  const providers: ConstructorParameters<typeof ToolService>[1] = {
    async getDefaults() {
      return {
        defaultModel: null,
        fastModel: null,
        imageModel: null,
        embeddingModel: null,
        rerankModel: null,
        speechModel: null,
        asrModel: null,
        thinkingMode: 'medium',
      };
    },
    async getModel(reference) {
      if (reference === 'ocr/PaddleOCR-VL')
        return {
          id: 'PaddleOCR-VL',
          providerId: 'ocr',
          enabled: true,
          modelType: 'ocr',
          modalitiesInput: ['image', 'pdf'],
          modalitiesOutput: ['text'],
        } as Awaited<ReturnType<typeof providers.getModel>>;
      throw new Error('No image models in this fixture');
    },
    async getProviderInstance(id) {
      if (id === 'ocr')
        return new PaddleOCRProvider({
          id,
          baseUrl: 'https://ocr.example/layout-parsing',
        });
      throw new Error('No image providers in this fixture');
    },
    async getProvider(id) {
      assert.equal(id, provider.id);
      return current;
    },
  };
  return {
    rows,
    reads,
    database,
    providers,
    setProvider: (value: typeof provider) => {
      current = value;
    },
    service: new ToolService(database, providers),
  };
}

test('registry builds exported tools by default, deduplicates selections and loads their settings', async () => {
  const f = fixture();
  const builtinIds = registeredToolIds.filter(
    (id) => !toolIds.some((configured) => configured === id),
  );
  const builtins = await f.service.buildTools(builtinIds);
  assert.deepEqual(Object.keys(builtins), builtinIds);
  assert.deepEqual(
    f.reads,
    builtinIds.map((id) => `tool:${id}`),
  );
  f.reads.length = 0;
  assert.deepEqual(await f.service.buildTools([]), {});
  const selected = await f.service.buildTools([
    'curr_time',
    'web_search',
    'web_search',
  ]);
  assert.deepEqual(Object.keys(selected), ['curr_time', 'web_search']);
  assert.deepEqual(f.reads, ['tool:curr_time', 'tool:web_search']);
  assert.deepEqual(Object.keys(await buildTools(registeredToolIds)), [
    ...registeredToolIds,
  ]);
  for (const id of ['unknown', '__proto__', 'constructor']) {
    await assert.rejects(
      f.service.buildTools([id as RegisteredToolId]),
      /Unknown tool ID/,
    );
  }
  assert.deepEqual(f.reads, ['tool:curr_time', 'tool:web_search']);
});

test('buildTools merges caller defaults with saved settings and honors disabled tools', async (t) => {
  const f = fixture();
  const counts: number[] = [];
  t.mock.method(
    LocalProvider.prototype,
    'webSearch',
    async (input: { numResults: number }) => {
      counts.push(input.numResults);
      return [];
    },
  );
  const defaults = { web_search: { numResults: 3 }, sleep: { enabled: false } };
  const first = await f.service.buildTools(['web_search', 'sleep'], defaults);
  assert.deepEqual(Object.keys(first), ['web_search']);
  assert.ok('execute' in first.web_search && first.web_search.execute);
  await first.web_search.execute({ query: 'query' }, {});
  // A partial persisted value overrides only supplied fields.
  f.rows.set('tool:web_search', {
    id: 'tool:web_search',
    value: { numResults: 7 },
  });
  const second = await f.service.buildTools(['web_search'], defaults);
  assert.ok('execute' in second.web_search && second.web_search.execute);
  await second.web_search.execute({ query: 'query' }, {});
  assert.deepEqual(counts, [3, 7]);
  assert.notEqual(first.web_search, second.web_search);
  assert.deepEqual(defaults, {
    web_search: { numResults: 3 },
    sleep: { enabled: false },
  });

  await f.service.update('web_search', {
    ...defaultWebSearchConfig,
    enabled: false,
  });
  assert.deepEqual(
    await f.service.buildTools(['web_search'], {
      web_search: { enabled: true },
    }),
    {},
  );
  await f.service.update('web_search', {
    ...defaultWebSearchConfig,
    enabled: true,
  });
  assert.ok(
    (
      await f.service.buildTools(['web_search'], {
        web_search: { enabled: false },
      })
    ).web_search,
  );
  await assert.rejects(
    buildTools(['web_search'], { web_search: { numResults: 0 } }),
    { name: 'ZodError' },
  );
  assert.deepEqual(
    Object.keys(
      await buildTools(['curr_time'], { web_search: { numResults: 0 } }),
    ),
    ['curr_time'],
  );
});

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

test('all built-in switches persist independently and preserve configured parameters', async () => {
  const f = fixture();
  await f.service.update('view_file', {
    ...defaultViewFileConfig,
    model: 'ocr/PaddleOCR-VL',
  });
  await f.service.update('web_search', {
    ...defaultWebSearchConfig,
    numResults: 7,
  });
  for (const id of registeredToolIds) {
    assert.equal((await f.service.setEnabled(id, false)).config.enabled, false);
    assert.deepEqual(await f.service.buildTools([id]), {});
    assert.equal((await f.service.setEnabled(id, true)).config.enabled, true);
    assert.ok((await f.service.buildTools([id]))[id]);
  }
  assert.deepEqual((await f.service.get('web_search')).config, {
    ...defaultWebSearchConfig,
    numResults: 7,
  });
  assert.deepEqual(await f.service.buildTools(['sleep'], {}, ['sleep']), {});
  await assert.rejects(f.service.setEnabled('unknown', false), {
    code: 'NOT_FOUND',
  });
});

test('persisted configuration controls new tool instances, without credentials in tool settings or results', async (t) => {
  const f = fixture();
  const catalog = await f.service.list();
  assert.deepEqual(
    catalog.map((tool) => tool.id),
    [...registeredToolIds],
  );
  assert.ok(catalog.every((tool) => tool.description && tool.config.enabled));
  assert.deepEqual(
    catalog
      .filter((tool) => tool.kind !== 'builtin')
      .sort(
        (a, b) =>
          toolIds.indexOf(a.id as (typeof toolIds)[number]) -
          toolIds.indexOf(b.id as (typeof toolIds)[number]),
      )
      .map(({ id, config }) => ({ id, config })),
    [
      { id: 'web_search', config: defaultWebSearchConfig },
      { id: 'web_fetch', config: defaultWebFetchConfig },
      { id: 'image_gen', config: defaultImageGenConfig },
      { id: 'speech', config: defaultSpeechConfig },
      { id: 'transcribe', config: defaultTranscribeConfig },
      { id: 'view_file', config: defaultViewFileConfig },
    ],
  );
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
  const first = (await restored.buildTools(toolIds)).web_search;
  assert.ok('execute' in first && first.execute);
  const output = await first.execute({ query: 'query' }, {});
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret/);
  await restored.update('web_search', { ...saved, enabled: false });
  assert.deepEqual(
    Object.keys(await restored.buildTools(toolIds)),
    toolIds.filter((id) => id !== 'web_search'),
  );
  await restored.update('web_search', { ...saved, enabled: true });
  const next = (await restored.buildTools(toolIds)).web_search;
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
  const tool = (await f.service.buildTools(toolIds)).web_search;
  assert.ok('execute' in tool && tool.execute);
  t.mock.method(LocalProvider.prototype, 'webSearch', async () => [
    { title: 'Fallback', href: 'https://example.com/' },
  ]);
  f.setProvider({ ...provider, enabled: false });
  assert.equal((await tool.execute({ query: 'query' }, {})).provider, 'local');
  t.mock.method(f.providers, 'getProvider', async () => {
    throw new Error('deleted');
  });
  assert.equal((await tool.execute({ query: 'query' }, {})).provider, 'local');
  await f.service.update('web_search', { ...config, enabled: false });
  assert.deepEqual(
    Object.keys(await f.service.buildTools(toolIds)),
    toolIds.filter((id) => id !== 'web_search'),
  );
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
  const updateImage = () =>
    client.tools.update({
      params: { toolId: 'image_gen' },
      body: defaultImageGenConfig,
    });
  const toggle = () =>
    client.tools.setEnabled({
      params: { toolId: 'sleep' },
      body: { enabled: false },
    });
  const updateSpeech = () =>
    client.tools.update({
      params: { toolId: 'speech' },
      body: defaultSpeechConfig,
    });
  for (const value of [undefined, 'user', 'admin-assistant']) {
    role = value;
    for (const call of [
      () => client.tools.list(),
      update,
      updateImage,
      updateSpeech,
      toggle,
    ])
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
    await assert.rejects(updateImage(), { code: 'FORBIDDEN' });
    await assert.rejects(updateSpeech(), { code: 'FORBIDDEN' });
    await assert.rejects(toggle(), { code: 'FORBIDDEN' });
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
  assert.deepEqual((await update()).config, body);
  assert.deepEqual((await updateImage()).config, defaultImageGenConfig);
  assert.deepEqual((await updateSpeech()).config, defaultSpeechConfig);
  assert.equal((await toggle()).config.enabled, false);
  assert.deepEqual(await f.service.buildTools(['sleep']), {});
  await assert.rejects(
    client.tools.setEnabled({
      params: { toolId: 'unknown' },
      body: { enabled: true },
    }),
    { code: 'NOT_FOUND' },
  );
  const toggled = await app.request('/api/admin/tools/curr_time/enabled', {
    method: 'PATCH',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(toggled.status, 200);
  assert.deepEqual(await f.service.buildTools(['curr_time']), {});
  const imageResponse = await app.request('/api/admin/tools/image_gen', {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...defaultImageGenConfig, timeoutMs: 600001 }),
  });
  assert.equal(imageResponse.status, 400);
  const listed = await client.tools.list();
  assert.deepEqual(
    listed.map((tool) => tool.id),
    [...registeredToolIds],
  );
  assert.deepEqual(
    listed.find((tool) => tool.id === 'web_search')?.config,
    body,
  );
  const fetchBody = { ...defaultWebFetchConfig, maxChars: 12345 };
  assert.deepEqual(
    (
      await client.tools.update({
        params: { toolId: 'web_fetch' },
        body: fetchBody,
      })
    ).config,
    fetchBody,
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
    (await new ToolService(f.database, f.providers).get('web_fetch')).config,
    config,
  );
  assert.doesNotMatch(
    JSON.stringify([...f.rows.values()]),
    /synthetic-secret|apiKey/,
  );
  assert.ok((await f.service.buildTools(toolIds)).web_fetch);
  await f.service.update('web_fetch', { ...config, enabled: false });
  assert.deepEqual(
    Object.keys(await f.service.buildTools(toolIds)),
    toolIds.filter((id) => id !== 'web_fetch'),
  );
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
