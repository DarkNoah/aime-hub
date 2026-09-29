import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test from 'node:test';
import { Pool } from 'pg';
import { createAuth } from '@aime/auth';
import { createDataSource, Provider, ProviderModel, Setting } from '@aime/db';
import {
  emptyModelDefaults,
  modelDefaultsSchema,
  modelInputSchema,
  modelReference,
  modelUpdateSchema,
  providerInputSchema,
  providerUpdateSchema,
  type ModelDefaults,
  type ModelInput,
} from '@aime/shared/providers';
import { createApp } from '../apps/server/src/app.js';
import {
  isPublicAddress,
  ProviderError,
  requestProviderJson,
} from '../apps/server/src/provider-network.js';
import {
  matchCatalogModel,
  ProviderService,
} from '../apps/server/src/provider-service.js';

const webOrigin = 'http://localhost:5173';
const baseUrl = 'https://provider.example.test/v1';
const catalogUrl = 'https://models.dev/api.json';
// Deliberately synthetic; never read developer credentials or call live providers.
const testKey = 'synthetic-provider-test-key';
type RequestJson = typeof requestProviderJson;

function fakeJson(responses: Record<string, unknown> = {}) {
  const calls: Parameters<RequestJson>[] = [];
  const request: RequestJson = async (...args) => {
    calls.push(args);
    const [url] = args;
    assert.ok(Object.hasOwn(responses, url), `Unexpected upstream URL: ${url}`);
    const value = responses[url];
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  return { request, calls };
}

function assertNoKey(value: unknown) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.hasOwn(value, 'apiKey'), false);
  assert.equal(Object.hasOwn(value, 'api_key'), false);
  for (const child of Object.values(value)) assertNoKey(child);
  assert.equal(JSON.stringify(value).includes(testKey), false);
}

test('provider schema 标准化、默认值及 partial 更新不注入默认值', () => {
  assert.deepEqual(providerInputSchema.parse({ name: ' Provider ', baseUrl }), {
    name: 'Provider',
    type: 'openai',
    baseUrl,
    enabled: true,
    metadata: {},
  });
  assert.deepEqual(providerUpdateSchema.parse({}), {});
  assert.deepEqual(providerUpdateSchema.parse({ name: ' Renamed ' }), {
    name: 'Renamed',
  });
  assert.equal(
    providerInputSchema.parse({
      name: 'Provider',
      baseUrl,
      apiKey: ` ${testKey} `,
    }).apiKey,
    testKey,
  );
  assert.equal(providerUpdateSchema.parse({ apiKey: '' }).apiKey, '');
  assert.equal(providerUpdateSchema.parse({ apiKey: '   ' }).apiKey, '');
  for (const patch of [
    { name: '' },
    { name: ' '.repeat(3) },
    { name: 'x'.repeat(101) },
    { type: 'anthropic' },
    { enabled: 'true' },
    { metadata: [] },
    { apiKey: 'a\r\nb' },
    { apiKey: 'x'.repeat(4097) },
    { apiKey: null },
    { baseUrl: 'ftp://provider.example.test' },
    { baseUrl: 'https://user:password@provider.example.test' },
    { baseUrl: `${baseUrl}?key=secret` },
    { baseUrl: `${baseUrl}#fragment` },
    { unexpected: true },
  ]) {
    assert.equal(
      providerInputSchema.safeParse({ name: 'Provider', baseUrl, ...patch })
        .success,
      false,
    );
    assert.equal(providerUpdateSchema.safeParse(patch).success, false);
  }
});

test('provider schema 对非法 URL 返回校验失败而不是抛出异常', async (t) => {
  for (const [name, schema] of [
    ['create', providerInputSchema],
    ['update', providerUpdateSchema],
  ] as const) {
    await t.test(name, () => {
      assert.equal(
        schema.safeParse({ name: 'Bad URL', baseUrl: 'not-a-url' }).success,
        false,
      );
    });
  }
});

test('model schema 支持 slash ID、能力、nullable 字段并拒绝越界及未知字段', () => {
  const model = modelInputSchema.parse({
    id: ' org/family/model ',
    name: ' Model ',
  });
  assert.deepEqual(model, {
    id: 'org/family/model',
    name: 'Model',
    description: null,
    displayName: null,
    enabled: true,
    deprecated: null,
    passTest: null,
    modalitiesInput: ['text'],
    modalitiesOutput: ['text'],
    reasoning: false,
    toolCall: false,
    limitContext: null,
    limitOutput: null,
    metadata: {},
  });
  assert.deepEqual(modelUpdateSchema.parse({}), {});
  assert.deepEqual(modelUpdateSchema.parse({ enabled: false }), {
    enabled: false,
  });
  assert.equal(
    modelInputSchema.safeParse({
      ...model,
      limitContext: 2147483647,
      modalitiesInput: ['text', 'image', 'audio', 'video', 'pdf'],
    }).success,
    true,
  );
  for (const patch of [
    { id: '' },
    { id: 'x'.repeat(257) },
    { id: 'a\u0000b' },
    { id: 'a\nb' },
    { id: 'a\u007fb' },
    { name: ' ' },
    { name: 'x'.repeat(257) },
    { description: 'x'.repeat(10001) },
    { displayName: 'x'.repeat(257) },
    { enabled: null },
    { deprecated: 'false' },
    { passTest: 1 },
    { reasoning: 'true' },
    { toolCall: null },
    { modalitiesInput: ['unknown'] },
    { modalitiesOutput: ['text', 'text', 'text', 'text', 'text', 'text'] },
    { limitContext: 0 },
    { limitContext: -1 },
    { limitOutput: 1.5 },
    { limitOutput: 2147483648 },
    { metadata: null },
    { providerId: 'injected' },
  ]) {
    assert.equal(
      modelInputSchema.safeParse({ ...model, ...patch }).success,
      false,
    );
    assert.equal(modelUpdateSchema.safeParse(patch).success, false);
  }
});

test('defaults schema 要求完整配置、合法 thinkingMode，引用保留完整模型 ID', () => {
  assert.deepEqual(
    modelDefaultsSchema.parse(emptyModelDefaults),
    emptyModelDefaults,
  );
  for (const thinkingMode of ['auto', 'on', 'off']) {
    assert.equal(
      modelDefaultsSchema.safeParse({ ...emptyModelDefaults, thinkingMode })
        .success,
      true,
    );
  }
  for (const input of [
    {},
    { ...emptyModelDefaults, thinkingMode: 'yes' },
    { ...emptyModelDefaults, defaultModel: 1 },
    { ...emptyModelDefaults, imageModel: 'x'.repeat(513) },
    { ...emptyModelDefaults, extra: true },
  ])
    assert.equal(modelDefaultsSchema.safeParse(input).success, false);
  assert.equal(
    modelReference('provider', 'org/family/model'),
    'provider/org/family/model',
  );
});

test('isPublicAddress 拒绝私有、loopback、保留地址和 IPv4-mapped IPv6', () => {
  for (const address of [
    '',
    'localhost',
    'invalid',
    '999.1.1.1',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:8.8.8.8',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('matchCatalogModel 忽略 provider 按末段匹配、优先精确 ID 并保留 raw metadata', () => {
  const raw = {
    id: 'other-vendor/family/model',
    name: 'Catalog Model',
    description: 'Capabilities',
    modalities: {
      input: ['text', 'image', 'video', 'audio'],
      output: ['image'],
    },
    reasoning: true,
    tool_call: true,
    limit: { context: 128000, output: 8192 },
    cost: { input: 0.5 },
    custom: { untouched: ['raw'] },
  };
  const exact = { id: 'gateway/model', name: 'Exact match' };
  const catalog = { unrelated: { models: { unrelatedKey: raw } } };
  assert.deepEqual(matchCatalogModel('gateway/model', catalog), {
    name: raw.name,
    description: raw.description,
    modalitiesInput: raw.modalities.input,
    modalitiesOutput: raw.modalities.output,
    reasoning: true,
    toolCall: true,
    limitContext: 128000,
    limitOutput: 8192,
    metadata: raw,
  });
  assert.deepEqual(
    matchCatalogModel('gateway/model', {
      ...catalog,
      z: { models: { exact } },
    }),
    { name: 'Exact match', metadata: exact },
  );
  assert.deepEqual(matchCatalogModel('missing', catalog), {});
  for (const invalid of [
    null,
    [],
    { models: [] },
    { vendor: { models: null } },
  ]) {
    assert.deepEqual(matchCatalogModel('model', invalid), {});
  }
  const invalidFields = {
    id: 'model',
    name: '',
    reasoning: 'yes',
    tool_call: true,
    modalities: { input: ['unknown'] },
    limit: { context: -1, output: 32 },
    raw: 'retained',
  };
  assert.deepEqual(
    matchCatalogModel('model', {
      vendor: { models: { model: invalidFields } },
    }),
    {
      toolCall: true,
      limitOutput: 32,
      metadata: invalidFields,
    },
  );
});

test('携带密钥的 HTTP 请求和私有地址在联网前被拒绝', async () => {
  for (const [url, key] of [
    ['http://8.8.8.8/models', testKey],
    ['http://127.0.0.1/models', undefined],
  ] as const) {
    await assert.rejects(
      requestProviderJson(url, key),
      (error: unknown) =>
        error instanceof ProviderError && error.code === 'INVALID_URL',
    );
  }
});

test(
  'PostgreSQL providers HTTP/service 集成',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = `providers_test_${randomBytes(8).toString('hex')}`;
    const options = `-c search_path=${schema}`;
    const root = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options },
    });
    const pool = new Pool({ connectionString, options });
    let server: Server | undefined = undefined;
    let schemaCreated = false;
    // Register before initialization: failures in migrations, auth or listen must also clean up.
    t.after(async () => {
      const errors: unknown[] = [];
      const cleanup = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await cleanup(async () => {
        if (!server?.listening) return;
        const closing = new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await closing;
      });
      await cleanup(() => pool.end());
      await cleanup(async () => {
        if (database.isInitialized) await database.destroy();
      });
      await cleanup(async () => {
        if (schemaCreated) await root.query(`DROP SCHEMA "${schema}" CASCADE`);
      });
      await cleanup(() => root.end());
      if (errors.length)
        throw new AggregateError(errors, 'Provider test cleanup failed');
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await database.initialize();
    const migrations = await database.runMigrations();
    const auth = createAuth({
      pool,
      secret: randomBytes(32).toString('hex'),
      baseURL: webOrigin,
      webOrigin,
      admins: 'admin',
    });
    const httpResponses: Record<string, unknown> = {};
    const httpFake = fakeJson(httpResponses);
    const service = new ProviderService(database, httpFake.request);
    server = createApp(auth, { service, webOrigin }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const cookies: Record<string, string> = {};
    const password = `Test-${randomBytes(16).toString('hex')}!`;
    for (const role of ['admin', 'user'] as const) {
      const created = await auth.api.createUser({
        body: {
          name: role,
          email: `${role}@providers.example.test`,
          password,
          role,
          data: { username: role },
        },
      });
      assert.equal(created.user.role, role);
      const login = await auth.api.signInUsername({
        body: { username: role, password },
        asResponse: true,
      });
      assert.equal(login.status, 200);
      cookies[role] = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      assert.ok(cookies[role]);
    }
    async function request(
      path: string,
      method = 'GET',
      body?: unknown,
      cookie = cookies.admin!,
      origin: string | null = webOrigin,
    ) {
      const response = await fetch(`${base}/api/admin${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          cookie,
          ...(origin === null ? {} : { origin }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      assertNoKey(data);
      return { response, data };
    }
    async function expect(
      path: string,
      method: string,
      body: unknown,
      status: number,
      code?: string,
    ) {
      const result = await request(path, method, body);
      assert.equal(result.response.status, status, `${method} ${path}`);
      if (code) assert.equal(result.data.code, code);
      return result.data;
    }
    async function newProvider(
      name: string,
      extra: Record<string, unknown> = {},
    ) {
      const result = await expect(
        '/providers',
        'POST',
        { name, baseUrl, ...extra },
        201,
      );
      assert.equal(typeof result.id, 'string');
      return result.id as string;
    }
    const modelPath = (providerId: string, id?: string) =>
      `/providers/${providerId}/models${id === undefined ? '' : `?modelId=${encodeURIComponent(id)}`}`;
    const offline = () => new ProviderService(database, fakeJson().request);

    await t.test(
      '随机 schema 迁移幂等、实体一致，连接未使用 public',
      async () => {
        assert.equal(migrations.length, database.migrations.length);
        assert.equal((await database.runMigrations()).length, 0);
        assert.equal(
          (await pool.query('SELECT current_schema() AS schema')).rows[0]
            .schema,
          schema,
        );
        assert.equal(
          (await database.query('SELECT current_schema() AS schema'))[0].schema,
          schema,
        );
        const changes = await database.driver.createSchemaBuilder().log();
        assert.deepEqual(
          changes.upQueries.map((query) => query.query),
          [],
        );
      },
    );

    await t.test(
      '真实会话验证所有 provider/model/default/sync 路由的 401/403',
      async () => {
        const id = await newProvider('Access control');
        const routes: Array<[string, string, unknown?]> = [
          ['/providers', 'GET'],
          ['/providers', 'POST', { name: 'Forbidden', baseUrl }],
          [`/providers/${id}`, 'GET'],
          [`/providers/${id}`, 'PATCH', { name: 'Forbidden' }],
          [`/providers/${id}`, 'DELETE'],
          [modelPath(id), 'GET'],
          [modelPath(id), 'POST', { id: 'model', name: 'Forbidden' }],
          [modelPath(id, 'model'), 'PATCH', { name: 'Forbidden' }],
          [modelPath(id, 'model'), 'DELETE'],
          [`/providers/${id}/sync`, 'POST', {}],
          ['/settings/models', 'GET'],
          ['/settings/models', 'PUT', emptyModelDefaults],
        ];
        for (const [path, method, body] of routes) {
          for (const [cookie, status, code] of [
            ['', 401, 'UNAUTHORIZED'],
            [cookies.user!, 403, 'FORBIDDEN'],
          ] as const) {
            const result = await request(path, method, body, cookie);
            assert.equal(result.response.status, status, `${method} ${path}`);
            assert.equal(result.data.code, code);
          }
          if (method !== 'GET') {
            for (const origin of ['https://untrusted.invalid', null]) {
              const result = await request(
                path,
                method,
                body,
                cookies.admin,
                origin,
              );
              assert.equal(result.response.status, 403, `${method} ${path}`);
              assert.equal(result.data.code, 'FORBIDDEN');
            }
          }
        }
        const result = await request(`/providers/${id}`);
        assert.equal(result.response.status, 200);
        assert.equal(result.response.headers.get('cache-control'), 'no-store');
        assert.equal(result.data.name, 'Access control');
        assert.deepEqual(result.data.models, []);
        assert.deepEqual(await service.getDefaults(), emptyModelDefaults);
        assert.equal(httpFake.calls.length, 0);
      },
    );

    await t.test(
      'HTTP schema 校验拒绝非法 body/query 且无持久化副作用',
      async () => {
        const before = await service.listProviders();
        for (const body of [
          { name: '', baseUrl },
          { name: 'Bad', baseUrl, injected: true },
          { name: 'Bad', baseUrl: `${baseUrl}?key=secret` },
        ]) {
          await expect('/providers', 'POST', body, 400, 'VALIDATION_ERROR');
        }
        assert.deepEqual(await service.listProviders(), before);
        const id = await newProvider('Validation');
        await expect(
          `/providers/${id}`,
          'PATCH',
          { enabled: 'false' },
          400,
          'VALIDATION_ERROR',
        );
        await expect(
          modelPath(id),
          'POST',
          { id: 'bad\u0000id', name: 'Bad' },
          400,
          'VALIDATION_ERROR',
        );
        await expect(
          modelPath(id),
          'POST',
          { id: 'bad', name: 'Bad', limitOutput: -1 },
          400,
          'VALIDATION_ERROR',
        );
        await expect(
          modelPath(id),
          'PATCH',
          { name: 'Bad' },
          400,
          'VALIDATION_ERROR',
        );
        await expect(
          modelPath(id),
          'DELETE',
          undefined,
          400,
          'VALIDATION_ERROR',
        );
        await expect(
          '/settings/models',
          'PUT',
          { ...emptyModelDefaults, thinkingMode: 'invalid' },
          400,
          'VALIDATION_ERROR',
        );
        const result = await request(`/providers/${id}`);
        assert.equal(result.data.enabled, true);
        assert.deepEqual(result.data.models, []);
      },
    );

    await t.test('HTTP 非法 URL 应返回 400 而非 500', async (subtest) => {
      const id = await newProvider('Invalid URL target');
      for (const method of ['POST', 'PATCH']) {
        await subtest.test(method, async () => {
          await expect(
            method === 'POST' ? '/providers' : `/providers/${id}`,
            method,
            { name: 'Bad URL', baseUrl: 'not-a-url' },
            400,
            'VALIDATION_ERROR',
          );
        });
      }
      assert.equal((await service.getProvider(id)).baseUrl, baseUrl);
    });

    await t.test(
      'provider CRUD 密钥不回传；空白输入省略保留，显式空字符串清除',
      async () => {
        const id = await newProvider('Credentials', {
          apiKey: testKey,
          metadata: { region: 'test' },
        });
        assert.equal((await service.getProvider(id)).apiKey, testKey);
        assert.equal(
          (await database.manager.findOneByOrFail(Provider, { id })).apiKey,
          undefined,
        );
        for (const patch of [
          { name: 'Renamed' },
          { apiKey: undefined, metadata: { region: 'updated' } },
        ]) {
          // An unchanged blank UI field is omitted from JSON, not submitted as an empty string.
          const updated = await expect(`/providers/${id}`, 'PATCH', patch, 200);
          assert.equal(updated.hasApiKey, true);
          assert.equal((await offline().getProvider(id)).apiKey, testKey);
        }
        const detail = await expect(`/providers/${id}`, 'GET', undefined, 200);
        assert.equal(detail.name, 'Renamed');
        assert.deepEqual(detail.metadata, { region: 'updated' });
        assert.equal(detail.hasApiKey, true);
        const list = await expect('/providers', 'GET', undefined, 200);
        assert.equal(
          list.find((provider: { id: string }) => provider.id === id).hasApiKey,
          true,
        );
        const cleared = await expect(
          `/providers/${id}`,
          'PATCH',
          { apiKey: '' },
          200,
        );
        assert.equal(cleared.hasApiKey, false);
        assert.equal((await offline().getProvider(id)).apiKey, null);
        await expect(
          `/providers/${id}`,
          'PATCH',
          { apiKey: testKey, enabled: false },
          200,
        );
        assert.equal((await service.getProvider(id)).enabled, false);
        await expect(
          modelPath(id),
          'POST',
          { id: 'child', name: 'Child' },
          201,
        );
        await expect(`/providers/${id}`, 'DELETE', undefined, 204);
        await expect(`/providers/${id}`, 'GET', undefined, 404, 'NOT_FOUND');
        await expect(
          `/providers/${id}`,
          'PATCH',
          { name: 'Missing' },
          404,
          'NOT_FOUND',
        );
        await expect(`/providers/${id}`, 'DELETE', undefined, 404, 'NOT_FOUND');
        assert.equal(
          (await service.listProviders()).some(
            (provider) => provider.id === id,
          ),
          false,
        );
        const deleted = await database
          .getRepository(Provider)
          .createQueryBuilder('provider')
          .withDeleted()
          .addSelect('provider.apiKey')
          .where('provider.id = :id', { id })
          .getOneOrFail();
        assert.ok(deleted.deletedAt);
        assert.equal(deleted.apiKey, null);
        assert.ok(
          (
            await database.manager.findOneOrFail(ProviderModel, {
              where: { providerId: id, id: 'child' },
              withDeleted: true,
            })
          ).deletedAt,
        );
        await assert.rejects(offline().getModel(modelReference(id, 'child')), {
          code: 'NOT_FOUND',
          status: 404,
        });
      },
    );

    await t.test(
      '同模型 ID 跨 provider 隔离，slash ID 编辑/冲突/删除/重建',
      async () => {
        const first = await newProvider('First');
        const second = await newProvider('Second');
        const id = 'org/family/model';
        for (const provider of [first, second]) {
          const created = await expect(
            modelPath(provider),
            'POST',
            { id, name: provider },
            201,
          );
          assert.equal(created.providerId, provider);
          assert.equal(created.id, id);
        }
        await expect(
          modelPath(first),
          'POST',
          { id, name: 'Duplicate' },
          409,
          'CONFLICT',
        );
        const updated = await expect(
          modelPath(first, id),
          'PATCH',
          {
            name: 'Manual',
            displayName: 'Display',
            metadata: { custom: true },
          },
          200,
        );
        assert.equal(updated.name, 'Manual');
        assert.equal(
          (await service.getModel(modelReference(second, id))).name,
          second,
        );
        const renamedId = 'another/org/renamed';
        await expect(
          modelPath(first),
          'POST',
          { id: renamedId, name: 'Conflict' },
          201,
        );
        await expect(
          modelPath(first, id),
          'PATCH',
          { id: renamedId },
          409,
          'CONFLICT',
        );
        await expect(modelPath(first, renamedId), 'DELETE', undefined, 204);
        const renamed = await expect(
          modelPath(first, id),
          'PATCH',
          { id: renamedId },
          200,
        );
        assert.equal(renamed.id, renamedId);
        assert.equal(renamed.name, 'Manual');
        assert.deepEqual(renamed.metadata, { custom: true });
        await assert.rejects(service.getModel(modelReference(first, id)), {
          code: 'NOT_FOUND',
          status: 404,
        });
        await expect(modelPath(first, renamedId), 'DELETE', undefined, 204);
        await expect(
          modelPath(first, renamedId),
          'DELETE',
          undefined,
          404,
          'NOT_FOUND',
        );
        await expect(
          modelPath(first, renamedId),
          'PATCH',
          { name: 'Missing' },
          404,
          'NOT_FOUND',
        );
        const rebuilt = await expect(
          modelPath(first),
          'POST',
          { id: renamedId, name: 'Rebuilt' },
          201,
        );
        assert.equal(rebuilt.name, 'Rebuilt');
        assert.equal(rebuilt.deletedAt, null);
        assert.equal(
          (await expect(modelPath(first), 'GET', undefined, 200)).length,
          1,
        );
        const detail = await expect(
          `/providers/${first}`,
          'GET',
          undefined,
          200,
        );
        assert.equal(detail.modelCount, 1);
        const list = await expect('/providers', 'GET', undefined, 200);
        assert.equal(
          list.find((provider: { id: string }) => provider.id === first)
            .modelCount,
          1,
        );
        await expect(`/providers/${first}`, 'DELETE', undefined, 204);
        assert.equal(
          (await service.getModel(modelReference(second, id))).name,
          second,
        );
      },
    );

    await t.test(
      'defaults 持久化、启用和图像输出校验；被引用禁止禁用/删除/改 ID',
      async (subtest) => {
        subtest.after(async () => {
          await service.setDefaults({ ...emptyModelDefaults });
        });
        const provider = await newProvider('Defaults');
        const disabledProvider = await newProvider('Disabled', {
          enabled: false,
        });
        const models = [
          { id: 'org/chat', name: 'Chat' },
          { id: 'org/fast', name: 'Fast' },
          { id: 'org/image', name: 'Image', modalitiesOutput: ['image'] },
          { id: 'disabled', name: 'Disabled', enabled: false },
          {
            id: 'image-input-only',
            name: 'Input only',
            modalitiesInput: ['image'],
          },
        ];
        for (const model of models)
          await expect(modelPath(provider), 'POST', model, 201);
        await expect(
          modelPath(disabledProvider),
          'POST',
          { id: 'model', name: 'Disabled provider model' },
          201,
        );
        assert.deepEqual(
          await expect('/settings/models', 'GET', undefined, 200),
          emptyModelDefaults,
        );
        const defaults: ModelDefaults = {
          defaultModel: modelReference(provider, 'org/chat'),
          fastModel: modelReference(provider, 'org/fast'),
          imageModel: modelReference(provider, 'org/image'),
          thinkingMode: 'on',
        };
        assert.deepEqual(
          await expect('/settings/models', 'PUT', defaults, 200),
          defaults,
        );
        assert.deepEqual(await offline().getDefaults(), defaults);
        assert.deepEqual(
          (await database.manager.findOneByOrFail(Setting, { id: 'models' }))
            .value,
          defaults,
        );
        for (const patch of [
          { defaultModel: 'malformed' },
          { defaultModel: 'missing/model' },
          { defaultModel: modelReference(provider, 'missing') },
          { fastModel: modelReference(provider, 'disabled') },
          { defaultModel: modelReference(disabledProvider, 'model') },
          { imageModel: modelReference(provider, 'org/chat') },
          { imageModel: modelReference(provider, 'image-input-only') },
        ]) {
          await expect(
            '/settings/models',
            'PUT',
            { ...defaults, ...patch },
            400,
            'INVALID_MODEL',
          );
          assert.deepEqual(await offline().getDefaults(), defaults);
        }
        for (const model of ['org/chat', 'org/fast', 'org/image']) {
          await expect(
            modelPath(provider, model),
            'PATCH',
            { enabled: false },
            409,
            'MODEL_IN_USE',
          );
          await expect(
            modelPath(provider, model),
            'PATCH',
            { id: `renamed/${model}` },
            409,
            'MODEL_IN_USE',
          );
          await expect(
            modelPath(provider, model),
            'DELETE',
            undefined,
            409,
            'MODEL_IN_USE',
          );
          const persisted = await offline().getModel(
            modelReference(provider, model),
          );
          assert.equal(persisted.id, model);
          assert.equal(persisted.enabled, true);
        }
        await expect(
          modelPath(provider, 'org/image'),
          'PATCH',
          { modalitiesOutput: ['text'] },
          409,
          'MODEL_IN_USE',
        );
        await expect(
          `/providers/${provider}`,
          'PATCH',
          { enabled: false },
          409,
          'MODEL_IN_USE',
        );
        await expect(
          `/providers/${provider}`,
          'DELETE',
          undefined,
          409,
          'MODEL_IN_USE',
        );
        await expect(
          modelPath(provider, 'org/chat'),
          'PATCH',
          { displayName: 'Allowed edit' },
          200,
        );
        assert.deepEqual(
          await expect('/settings/models', 'GET', undefined, 200),
          defaults,
        );
        assert.deepEqual(
          (await offline().getModel(defaults.imageModel!)).modalitiesOutput,
          ['image'],
        );
        await expect(
          '/settings/models',
          'PUT',
          { ...emptyModelDefaults, thinkingMode: 'off' },
          200,
        );
        await expect(
          modelPath(provider, 'org/chat'),
          'PATCH',
          { id: 'renamed/chat', enabled: false },
          200,
        );
        await expect(
          modelPath(provider, 'org/image'),
          'DELETE',
          undefined,
          204,
        );
        await expect(
          `/providers/${provider}`,
          'PATCH',
          { enabled: false },
          200,
        );
        await expect(`/providers/${provider}`, 'DELETE', undefined, 204);
      },
    );

    await t.test(
      'HTTP sync 请求 /models 携带密钥，catalog 不带密钥，限流按 provider 隔离',
      async () => {
        const provider = await newProvider('HTTP sync', {
          baseUrl: `${baseUrl}///`,
          apiKey: testKey,
        });
        const another = await newProvider('Other HTTP sync');
        httpResponses[`${baseUrl}/models`] = {
          data: [{ id: 'raw/model' }, { id: 'raw/model' }],
        };
        httpResponses[catalogUrl] = {};
        const start = httpFake.calls.length;
        assert.deepEqual(
          await expect(`/providers/${provider}/sync`, 'POST', {}, 200),
          { added: 1, deprecated: 0, total: 1, catalogAvailable: true },
        );
        assert.deepEqual(httpFake.calls.slice(start), [
          [`${baseUrl}/models`, testKey],
          [catalogUrl, undefined, 20_000_000],
        ]);
        await expect(
          `/providers/${provider}/sync`,
          'POST',
          {},
          429,
          'RATE_LIMITED',
        );
        assert.equal(httpFake.calls.length, start + 2);
        await expect(`/providers/${another}/sync`, 'POST', {}, 200);
        assert.deepEqual(httpFake.calls.slice(start + 2), [
          [`${baseUrl}/models`, undefined],
          [catalogUrl, undefined, 20_000_000],
        ]);
        const fresh = new ProviderService(database, httpFake.request);
        assert.deepEqual(await fresh.syncModels(provider), {
          added: 0,
          deprecated: 0,
          total: 1,
          catalogAvailable: true,
        });
      },
    );

    await t.test(
      'sync 新增补能力和 raw；existing 手动字段保留；deprecated 双向更新',
      async () => {
        const provider = await newProvider('Sync capabilities', {
          apiKey: testKey,
        });
        const manual = modelInputSchema.parse({
          id: 'gateway/manual',
          name: 'Manual name',
          description: 'Manual description',
          displayName: 'Manual display',
          enabled: false,
          deprecated: true,
          passTest: true,
          modalitiesInput: ['audio'],
          modalitiesOutput: ['text'],
          reasoning: false,
          toolCall: false,
          limitContext: 1234,
          limitOutput: 123,
          metadata: { manual: { keep: true } },
        });
        await service.createModel(provider, manual);
        await service.createModel(
          provider,
          modelInputSchema.parse({
            id: 'gone',
            name: 'Gone',
            deprecated: false,
          }),
        );
        const raw = {
          id: 'different-provider/new',
          name: 'Catalog new',
          description: 'Catalog description',
          modalities: {
            input: ['text', 'image', 'video', 'audio'],
            output: ['image'],
          },
          reasoning: true,
          tool_call: true,
          limit: { context: 128000, output: 8192 },
          cost: { input: 0.5 },
        };
        const enriched = fakeJson({
          [`${baseUrl}/models`]: {
            data: [
              { id: manual.id },
              { id: 'gateway/new' },
              { id: 'unknown/model' },
              { id: 'gateway/new' },
            ],
          },
          [catalogUrl]: {
            unrelated: {
              models: {
                new: raw,
                manual: {
                  ...raw,
                  id: 'different/manual',
                  name: 'Do not overwrite',
                },
              },
            },
          },
        });
        const sync = new ProviderService(database, enriched.request);
        assert.deepEqual(await sync.syncModels(provider), {
          added: 2,
          deprecated: 1,
          total: 3,
          catalogAvailable: true,
        });
        const existing = await offline().getModel(
          modelReference(provider, manual.id),
        );
        for (const key of Object.keys(manual) as Array<keyof ModelInput>) {
          assert.deepEqual(
            existing[key],
            key === 'deprecated' ? false : manual[key],
            key,
          );
        }
        const added = await offline().getModel(
          modelReference(provider, 'gateway/new'),
        );
        assert.equal(added.id, 'gateway/new');
        assert.equal(added.name, raw.name);
        assert.equal(added.description, raw.description);
        assert.equal(added.enabled, true);
        assert.equal(added.deprecated, false);
        assert.equal(added.passTest, null);
        assert.deepEqual(added.modalitiesInput, raw.modalities.input);
        assert.deepEqual(added.modalitiesOutput, raw.modalities.output);
        assert.equal(added.reasoning, true);
        assert.equal(added.toolCall, true);
        assert.equal(added.limitContext, 128000);
        assert.equal(added.limitOutput, 8192);
        assert.deepEqual(added.metadata, raw);
        const unknown = await offline().getModel(
          modelReference(provider, 'unknown/model'),
        );
        assert.equal(unknown.name, 'unknown/model');
        assert.deepEqual(unknown.modalitiesInput, ['text']);
        assert.deepEqual(unknown.metadata, {});
        assert.equal(
          (await offline().getModel(modelReference(provider, 'gone')))
            .deprecated,
          true,
        );
        const returning = fakeJson({
          [`${baseUrl}/models`]: { data: [{ id: 'gone' }] },
          [catalogUrl]: {},
        });
        assert.deepEqual(
          await new ProviderService(database, returning.request).syncModels(
            provider,
          ),
          { added: 0, deprecated: 3, total: 1, catalogAvailable: true },
        );
        assert.equal(
          (await offline().getModel(modelReference(provider, 'gone')))
            .deprecated,
          false,
        );
        assert.equal(
          (await offline().getModel(modelReference(provider, manual.id)))
            .deprecated,
          true,
        );
        await service.deleteModel(provider, 'gateway/new');
        const restore = fakeJson({
          [`${baseUrl}/models`]: { data: [{ id: 'gateway/new' }] },
          [catalogUrl]: {},
        });
        assert.equal(
          (
            await new ProviderService(database, restore.request).syncModels(
              provider,
            )
          ).added,
          0,
        );
        await assert.rejects(
          offline().getModel(modelReference(provider, 'gateway/new')),
          (error: unknown) =>
            error instanceof ProviderError && error.code === 'NOT_FOUND',
        );
        const removed = await database
          .getRepository(ProviderModel)
          .findOneOrFail({
            where: { providerId: provider, id: 'gateway/new' },
            withDeleted: true,
          });
        assert.ok(removed.deletedAt);
        assert.deepEqual(removed.metadata, raw);
      },
    );

    await t.test('同步超过冷却时间仍互斥，结束后释放运行标记', async () => {
      const provider = await newProvider('Concurrent sync');
      let resolveRequest!: (value: unknown) => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const waiting = new Promise<unknown>((resolve) => {
        resolveRequest = resolve;
      });
      const concurrent = new ProviderService(database, async (url) => {
        if (url === catalogUrl) return {};
        started();
        return waiting;
      });
      const running = concurrent.syncModels(provider);
      await entered;
      const originalNow = Date.now;
      try {
        const later = originalNow() + 61000;
        Date.now = () => later;
        await assert.rejects(
          concurrent.syncModels(provider),
          (error: unknown) =>
            error instanceof ProviderError && error.code === 'RATE_LIMITED',
        );
      } finally {
        Date.now = originalNow;
        resolveRequest({ data: [] });
      }
      await running;
      try {
        const later = originalNow() + 61000;
        Date.now = () => later;
        assert.equal((await concurrent.syncModels(provider)).total, 0);
      } finally {
        Date.now = originalNow;
      }
    });

    await t.test(
      'sync discovery 失败或无效响应不写入、不错误标记 deprecated',
      async (subtest) => {
        for (const [label, response] of [
          ['upstream error', new ProviderError('UPSTREAM_ERROR', 502)],
          ['missing data', {}],
          ['invalid shape', { data: 'invalid' }],
          ['empty ID', { data: [{ id: '' }] }],
          [
            'control character',
            { data: [{ id: 'new' }, { id: 'bad\u0000id' }] },
          ],
        ] as const) {
          await subtest.test(label, async () => {
            const provider = await newProvider(`Failure ${label}`);
            for (const [id, deprecated] of [
              ['available', false],
              ['already-gone', true],
              ['manual', null],
            ] as const) {
              await service.createModel(
                provider,
                modelInputSchema.parse({ id, name: id, deprecated }),
              );
            }
            const before = await service.getPublicProvider(provider);
            const fake = fakeJson({ [`${baseUrl}/models`]: response });
            await assert.rejects(
              new ProviderService(database, fake.request).syncModels(provider),
              { code: 'UPSTREAM_ERROR', status: 502 },
            );
            assert.deepEqual(await service.getPublicProvider(provider), before);
            assert.deepEqual(fake.calls, [[`${baseUrl}/models`, undefined]]);
          });
        }
      },
    );

    await t.test(
      'sync catalog 失败仍接受 discovery；有效空列表才标记 deprecated',
      async () => {
        for (const catalog of [
          new ProviderError('UPSTREAM_ERROR', 502),
          { invalid: true },
        ]) {
          const provider = await newProvider('Optional catalog');
          await service.createModel(
            provider,
            modelInputSchema.parse({ id: 'old', name: 'Old' }),
          );
          const fake = fakeJson({
            [`${baseUrl}/models`]: { data: [{ id: 'new' }] },
            [catalogUrl]: catalog,
          });
          assert.deepEqual(
            await new ProviderService(database, fake.request).syncModels(
              provider,
            ),
            { added: 1, deprecated: 1, total: 1, catalogAvailable: false },
          );
          const model = await offline().getModel(
            modelReference(provider, 'new'),
          );
          assert.equal(model.name, 'new');
          assert.deepEqual(model.metadata, {});
          assert.equal(model.deprecated, false);
          const empty = fakeJson({
            [`${baseUrl}/models`]: { data: [] },
            [catalogUrl]: {},
          });
          assert.deepEqual(
            await new ProviderService(database, empty.request).syncModels(
              provider,
            ),
            { added: 0, deprecated: 2, total: 0, catalogAvailable: true },
          );
          assert.equal(
            (await offline().getModel(modelReference(provider, 'new')))
              .deprecated,
            true,
          );
        }
      },
    );

    await t.test(
      'getModel 完全离线读取持久化能力，按第一个 slash 拆引用',
      async () => {
        const provider = await newProvider('Offline');
        const id = 'org/family/model';
        await service.createModel(
          provider,
          modelInputSchema.parse({
            id,
            name: 'Offline',
            modalitiesInput: ['text', 'image', 'video', 'audio'],
            limitContext: 64000,
          }),
        );
        await service.createModel(
          provider,
          modelInputSchema.parse({ id: 'text', name: 'Text' }),
        );
        const fake = fakeJson();
        const reader = new ProviderService(database, fake.request);
        const model = await reader.getModel(modelReference(provider, id));
        assert.equal(model.id, id);
        assert.equal(model.providerId, provider);
        assert.equal(model.supportsImageInput, true);
        assert.equal(model.supportsVideoInput, true);
        assert.equal(model.supportsAudioInput, true);
        assert.equal(model.context, 64000);
        const text = await reader.getModel(modelReference(provider, 'text'));
        assert.equal(text.supportsImageInput, false);
        assert.equal(text.supportsVideoInput, false);
        assert.equal(text.supportsAudioInput, false);
        assert.equal(text.context, null);
        await assert.rejects(reader.getModel('malformed'), {
          code: 'INVALID_MODEL',
          status: 400,
        });
        await assert.rejects(
          reader.getModel(modelReference(provider, 'missing')),
          { code: 'NOT_FOUND', status: 404 },
        );
        await assert.rejects(reader.getModel('missing-provider/model'), {
          code: 'NOT_FOUND',
          status: 404,
        });
        assert.deepEqual(fake.calls, []);
      },
    );
  },
);
