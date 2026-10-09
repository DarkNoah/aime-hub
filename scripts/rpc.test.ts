import { openSessionStub } from './fixtures/thread-session.js';
import { modelInputSchema } from '@aime/shared/providers';
import {
  providerDetail,
  providerModel,
} from '../apps/server/src/modules/providers/dto.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { createApp } from '../apps/server/src/app.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import type { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import type { ProviderService } from '../apps/server/src/modules/providers/service.js';
import { ProviderError } from '../apps/server/src/modules/providers/network.js';
import { fakeMemory } from './fixtures/thread-memory.js';

const origin = 'http://localhost:5173';
const settings = { model: null, reasoningEffort: 'auto' } as const;

test('typed RPC client reaches Hono with session, origin, validation, ownership and sanitized errors', async (t) => {
  const root = await realpath(await mkdtemp('/tmp/rpc-migration-'));
  const threads = new ThreadService(fakeMemory().memory, {
    async validate() {},
    async createWorkspace() {
      return root;
    },
    open: openSessionStub,
  });
  t.after(async () => {
    await threads.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  let user: { id: string; role: string } | undefined;
  let requestOrigin: string | undefined = origin;
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof createApp>[0];
  let modelId = '';
  const providers = {
    async listAvailableModels() {
      return { providers: [] };
    },
    async deleteModel(_providerId: string, id: string) {
      modelId = id;
    },
    async syncModels() {
      throw new ProviderError('UPSTREAM_ERROR', 502);
    },
    async listProviders() {
      throw new Error('secret connection string');
    },
  } as unknown as ProviderService;
  const models = {
    async getPreferences() {
      return settings;
    },
  } as unknown as LanguageModelService;
  const app = createApp(
    auth,
    { service: providers, webOrigin: origin },
    { threads, models, webOrigin: origin },
  );
  const client = createApiClient(() => `${origin}/api/rpc`);
  let credentials: RequestCredentials | undefined;
  t.mock.method(globalThis, 'fetch', (request: Request, init: RequestInit) => {
    credentials = init.credentials;
    const headers = new Headers(request.headers);
    if (requestOrigin) headers.set('origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });
  assert.equal((await app.request('/api/health')).status, 200);
  await assert.rejects(client.providers.available(), { code: 'UNAUTHORIZED' });
  user = { id: 'alice', role: 'user' };
  assert.deepEqual(await client.providers.available(), { providers: [] });
  assert.equal(credentials, 'same-origin');
  await assert.rejects(client.providers.list(), { code: 'FORBIDDEN' });
  requestOrigin = undefined;
  await assert.rejects(client.threads.create({ body: settings }), {
    code: 'FORBIDDEN',
  });
  requestOrigin = 'https://other.example';
  await assert.rejects(client.threads.create({ body: settings }), {
    code: 'FORBIDDEN',
  });
  requestOrigin = origin;
  await assert.rejects(client.threads.list({ query: { page: -1 } }), {
    code: 'VALIDATION_ERROR',
  });
  const getMutation = await app.request(
    `/api/rpc/threads/create?data=${encodeURIComponent(JSON.stringify({ json: { body: settings } }))}`,
  );
  assert.equal(getMutation.status, 405);
  const thread = await client.threads.create({ body: settings });
  assert.match(thread.id, /^[a-zA-Z0-9_-]{16}$/);
  assert.equal(
    (await client.threads.list({ query: {} })).threads[0].id,
    thread.id,
  );
  assert.deepEqual(await client.threads.preferences(), settings);
  await client.threads.update({
    params: { threadId: thread.id },
    body: { title: 'RPC title' },
  });
  assert.equal(
    (await client.threads.get({ params: { threadId: thread.id } })).thread
      .title,
    'RPC title',
  );
  await client.files.mutate({
    params: { threadId: thread.id },
    body: { operation: 'create', path: 'note.txt', kind: 'file' },
  });
  assert.equal(
    (await client.files.list({ params: { threadId: thread.id }, query: {} }))
      .entries[0].name,
    'note.txt',
  );
  await assert.rejects(
    client.files.preview({
      params: { threadId: thread.id },
      query: { path: '../secret' },
    }),
    { code: 'FILE_INVALID_PATH' },
  );
  user = { id: 'bob', role: 'user' };
  await assert.rejects(
    client.threads.get({ params: { threadId: thread.id } }),
    { code: 'THREAD_NOT_FOUND' },
  );
  user = { id: 'alice', role: 'admin' };
  const id = 'vendor/model?variant=1&name=#图像';
  await client.providers.removeModel({
    params: { providerId: 'p1' },
    query: { modelId: id },
  });
  assert.equal(modelId, id);
  await assert.rejects(
    client.providers.sync({ params: { providerId: 'p1' } }),
    { code: 'UPSTREAM_ERROR' },
  );
  await assert.rejects(client.providers.list(), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'INTERNAL_ERROR');
    assert.doesNotMatch(String(error), /secret connection/);
    return true;
  });
  await client.threads.remove({ params: { threadId: thread.id } });
  assert.equal((await client.threads.list({ query: {} })).threads.length, 0);
  const tooLarge = await app.request('/api/rpc/providers/create', {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { body: { name: 'x'.repeat(130 * 1024) } } }),
  });
  assert.equal(tooLarge.status, 413);
  await assert.rejects(
    client.providers.create({
      body: { name: 'x'.repeat(130 * 1024), baseUrl: 'https://example.com' },
    }),
    { code: 'VALIDATION_ERROR', status: 413 },
  );
});

test('Better Auth receives a Web Request and ignores spoofed client IP headers', async () => {
  let seen: Request | undefined;
  const auth = {
    handler: async (request: Request) => {
      seen = request;
      return new Response('auth', {
        headers: { 'Set-Cookie': 'session=test; HttpOnly' },
      });
    },
  } as unknown as Parameters<typeof createApp>[0];
  const response = await createApp(auth).request('/api/auth/get-session', {
    headers: { 'x-aime-client-ip': 'spoofed' },
  });
  assert.equal(await response.text(), 'auth');
  assert.equal(seen?.headers.get('x-aime-client-ip'), '');
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
});

test('provider DTOs keep ISO timestamps and strip ORM relations and credentials', () => {
  const date = new Date('2026-10-06T00:00:00.000Z');
  const model = {
    ...modelInputSchema.parse({ id: 'vendor/model', name: 'Model' }),
    providerId: 'provider',
    createdAt: date,
    updatedAt: date,
    deletedAt: null,
    provider: { apiKey: 'secret' },
  } as Parameters<typeof providerModel>[0];
  const detail = providerDetail({
    id: 'provider',
    name: 'Provider',
    type: 'openai',
    baseUrl: 'https://example.com',
    enabled: true,
    metadata: {},
    hasApiKey: true,
    modelCount: 1,
    createdAt: date,
    updatedAt: date,
    models: [model],
  });
  assert.equal(detail.createdAt, date.toISOString());
  assert.equal(detail.models[0].updatedAt, date.toISOString());
  assert.equal(detail.models[0].id, 'vendor/model');
  assert.equal(Object.hasOwn(detail.models[0], 'provider'), false);
  assert.equal(Object.hasOwn(detail.models[0], 'deletedAt'), false);
  assert.doesNotMatch(JSON.stringify(detail), /secret/);
});
