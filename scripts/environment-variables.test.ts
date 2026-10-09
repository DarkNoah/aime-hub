import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createDataSource, EnvironmentVariable } from '@aime/db';
import {
  environmentVariableInputSchema,
  environmentVariableUpdateSchema,
  type EnvironmentVariable as Variable,
  type EnvironmentVariableInput,
  type EnvironmentVariableUpdate,
} from '@aime/shared/environment-variables';
import { createApp } from '../apps/server/src/app.js';
import { EnvironmentVariableError } from '../apps/server/src/modules/environment-variables/errors.js';
import { EnvironmentVariableService } from '../apps/server/src/modules/environment-variables/service.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';
import { CreateEnvironmentVariables1780000004000 } from '../packages/db/src/migrations/1780000004000-create-environment-variables.js';

test('environment variable validation preserves empty, whitespace and multiline values and validates partial updates', () => {
  for (const value of [
    '',
    '  secret  ',
    'line one\nline two\r\n',
    '"$`\\测试',
  ]) {
    assert.deepEqual(
      environmentVariableInputSchema.parse({ name: ' API_KEY ', value }),
      {
        name: 'API_KEY',
        value,
        description: '',
      },
    );
  }
  assert.deepEqual(
    environmentVariableUpdateSchema.parse({ description: ' note ' }),
    { description: 'note' },
  );
  assert.deepEqual(environmentVariableUpdateSchema.parse({ value: '' }), {
    value: '',
  });
  for (const name of [
    '',
    '1_KEY',
    'A-B',
    'A=B',
    'A B',
    '变量',
    'X'.repeat(129),
  ]) {
    assert.equal(
      environmentVariableInputSchema.safeParse({ name, value: '' }).success,
      false,
    );
  }
  for (const patch of [
    {},
    { value: null },
    { value: '\0' },
    { value: 'x'.repeat(16385) },
    { description: 'x'.repeat(1001) },
    { description: '\0' },
    { enabled: true },
  ]) {
    assert.equal(
      environmentVariableUpdateSchema.safeParse(patch).success,
      false,
    );
  }
});

function memoryService() {
  const rows = new Map<string, Variable>();
  let calls = 0;
  const service = {
    async list() {
      calls++;
      return [...rows.values()];
    },
    async get(id: string) {
      calls++;
      const row = rows.get(id);
      if (!row)
        throw new EnvironmentVariableError(
          'ENVIRONMENT_VARIABLE_NOT_FOUND',
          404,
        );
      return row;
    },
    async create(input: EnvironmentVariableInput) {
      calls++;
      if ([...rows.values()].some((row) => row.name === input.name))
        throw new EnvironmentVariableError(
          'ENVIRONMENT_VARIABLE_CONFLICT',
          409,
        );
      const row = {
        ...input,
        description: input.description ?? '',
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rows.set(row.id, row);
      return row;
    },
    async update(id: string, input: EnvironmentVariableUpdate) {
      const row = await this.get(id);
      const updated = { ...row, ...input } as Variable;
      rows.set(id, updated);
      return updated;
    },
    async remove(id: string) {
      await this.get(id);
      rows.delete(id);
    },
  };
  return {
    service: service as unknown as EnvironmentVariableService,
    calls: () => calls,
  };
}

test('environment variable HTTP and typed RPC enforce authentication, admin role, origin and full CRUD', async (t) => {
  const origin = 'http://localhost:5173';
  const path = '/api/admin/environment-variables';
  let user: { id: string; role: string } | undefined;
  let requestOrigin: string | undefined = origin;
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof createApp>[0];
  const fixture = memoryService();
  const app = createApp(auth, undefined, undefined, undefined, {
    service: fixture.service,
    webOrigin: origin,
  });
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    if (requestOrigin) headers.set('Origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });
  const id = randomUUID();
  const input = { name: 'API_KEY', value: '  synthetic-only-value  ' };
  const rpcCalls = [
    () => client.environmentVariables.list(),
    () => client.environmentVariables.get({ params: { id } }),
    () => client.environmentVariables.create({ body: input }),
    () =>
      client.environmentVariables.update({
        params: { id },
        body: { value: '' },
      }),
    () => client.environmentVariables.remove({ params: { id } }),
  ];
  const httpCalls = [
    ['GET', path, undefined],
    ['GET', `${path}/${id}`, undefined],
    ['POST', path, input],
    ['PATCH', `${path}/${id}`, { value: '' }],
    ['DELETE', `${path}/${id}`, undefined],
  ] as const;
  for (const role of [undefined, 'user', 'admin-assistant']) {
    user = role ? { id: 'tester', role } : undefined;
    for (const call of rpcCalls)
      await assert.rejects(call(), {
        code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
      });
    for (const [method, url, body] of httpCalls) {
      const response = await app.request(url, {
        method,
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, role ? 403 : 401);
      assert.doesNotMatch(await response.text(), /synthetic-only-value/);
    }
  }
  assert.equal(fixture.calls(), 0);
  user = { id: 'admin', role: 'admin' };
  for (const badOrigin of [undefined, 'https://other.example']) {
    requestOrigin = badOrigin;
    for (const call of rpcCalls.slice(2))
      await assert.rejects(call(), { code: 'FORBIDDEN' });
    for (const [method, url, body] of httpCalls.slice(2)) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (badOrigin) headers.Origin = badOrigin;
      assert.equal(
        (
          await app.request(url, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
        ).status,
        403,
      );
    }
  }
  assert.equal(fixture.calls(), 0);
  requestOrigin = origin;
  await assert.rejects(
    client.environmentVariables.create({
      body: { ...input, name: '1INVALID' },
    }),
    { code: 'VALIDATION_ERROR' },
  );
  await assert.rejects(
    client.environmentVariables.update({ params: { id }, body: {} }),
    { code: 'VALIDATION_ERROR' },
  );
  const created = await client.environmentVariables.create({ body: input });
  assert.equal(created.value, input.value);
  assert.equal(created.description, '');
  assert.deepEqual(
    await client.environmentVariables.get({ params: { id: created.id } }),
    created,
  );
  await assert.rejects(client.environmentVariables.create({ body: input }), {
    code: 'ENVIRONMENT_VARIABLE_CONFLICT',
    status: 409,
  });
  const list = await app.request(path);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await list.json(), [created]);
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const changed = await app.request(`${path}/${created.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      name: 'RENAMED_KEY',
      value: '',
      description: ' note ',
    }),
  });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).value, '');
  assert.equal(
    (await client.environmentVariables.list())[0].name,
    'RENAMED_KEY',
  );
  const viaHttp = await app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'MULTILINE', value: 'line 1\nline 2' }),
  });
  assert.equal(viaHttp.status, 201);
  const second = (await viaHttp.json()) as Variable;
  assert.equal((await app.request(`${path}/${second.id}`)).status, 200);
  assert.equal(
    (await app.request(`${path}/${created.id}`, { method: 'DELETE', headers }))
      .status,
    204,
  );
  await client.environmentVariables.remove({ params: { id: second.id } });
  assert.deepEqual(await client.environmentVariables.list(), []);
  await assert.rejects(
    client.environmentVariables.get({ params: { id: created.id } }),
    { code: 'ENVIRONMENT_VARIABLE_NOT_FOUND', status: 404 },
  );
  assert.equal(
    (await app.request(`${path}/${created.id}`, { method: 'DELETE', headers }))
      .status,
    404,
  );
  t.mock.method(fixture.service, 'list', async () => {
    throw new Error('synthetic-secret-database-detail');
  });
  const failed = await app.request(path);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { code: 'INTERNAL_ERROR' });
});

test(
  'environment variable PostgreSQL migration, persistence, concurrent uniqueness and partial updates',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `environment_test_${randomBytes(8).toString('hex')}`;
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
    assert.equal((await database.runMigrations()).length, 0);
    const service = new EnvironmentVariableService(database);
    const input = {
      name: 'API_KEY',
      value: '  synthetic-secret\nsecond line  ',
      description: 'description',
    };
    const attempts = await Promise.allSettled([
      service.create(input),
      service.create(input),
    ]);
    assert.equal(
      attempts.filter((attempt) => attempt.status === 'fulfilled').length,
      1,
    );
    const failure = attempts.find((attempt) => attempt.status === 'rejected');
    assert.equal(failure?.reason.code, 'ENVIRONMENT_VARIABLE_CONFLICT');
    const saved = (await service.list())[0];
    assert.equal(saved.value, input.value);
    assert.equal(
      (
        await database
          .getRepository(EnvironmentVariable)
          .findOneByOrFail({ id: saved.id })
      ).value,
      undefined,
    );
    const second = await service.create({ name: 'OTHER', value: '' });
    await assert.rejects(service.update(second.id, { name: input.name }), {
      code: 'ENVIRONMENT_VARIABLE_CONFLICT',
    });
    assert.equal((await service.get(second.id)).name, 'OTHER');
    await service.update(saved.id, { description: 'new description' });
    assert.equal((await service.get(saved.id)).value, input.value);
    await service.update(saved.id, { name: 'RENAMED', value: '' });
    await database.destroy();
    await database.initialize();
    const reloaded = new EnvironmentVariableService(database);
    assert.equal((await reloaded.get(saved.id)).value, '');
    assert.equal((await reloaded.get(saved.id)).name, 'RENAMED');
    await reloaded.remove(saved.id);
    await reloaded.remove(second.id);
    for (const call of [
      () => reloaded.get(saved.id),
      () => reloaded.update(saved.id, { value: 'x' }),
      () => reloaded.remove(saved.id),
    ]) {
      await assert.rejects(call(), { code: 'ENVIRONMENT_VARIABLE_NOT_FOUND' });
    }
    await reloaded.create({ name: input.name, value: 'replacement' });
    assert.equal((await reloaded.list()).length, 1);
    const runner = database.createQueryRunner();
    try {
      const migration = new CreateEnvironmentVariables1780000004000();
      await migration.down(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }
    assert.deepEqual(await reloaded.list(), []);
  },
);
