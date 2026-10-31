import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
  createDataSource,
  EnvironmentVariable,
  Project,
  ProjectMember,
  CreateProjectTables1780000002000,
} from '@aime/db';
import { ProjectListState1780000003000 } from '../packages/db/src/migrations/1780000003000-project-list-state.js';
import { CreateEnvironmentVariables1780000004000 } from '../packages/db/src/migrations/1780000004000-create-environment-variables.js';
import { UserEnvironmentVariables1780000028000 } from '../packages/db/src/migrations/1780000028000-user-environment-variables.js';
import { ProjectEnvironmentVariables1780000037000 } from '../packages/db/src/migrations/1780000037000-project-environment-variables.js';
import { EnvironmentVariableService } from '../apps/server/src/modules/environment-variables/service.js';
import { ProjectService } from '../apps/server/src/modules/projects/service.js';
import { LocalApiAccess } from '../apps/server/src/modules/auth/local-api.js';
import { createApp } from '../apps/server/src/app.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';

test(
  'project variables enforce HTTP/RPC permissions, isolation, precedence, persistence and deletion',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `project_env_test_${randomBytes(8).toString('hex')}`;
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
      migrations: [
        CreateProjectTables1780000002000,
        ProjectListState1780000003000,
        CreateEnvironmentVariables1780000004000,
        UserEnvironmentVariables1780000028000,
        ProjectEnvironmentVariables1780000037000,
      ],
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
    const projectId = 'project000000001';
    const otherId = 'project000000002';
    for (const id of [projectId, otherId]) {
      await database
        .getRepository(Project)
        .save({ id, name: id, createdBy: 'owner' });
      await database.getRepository(ProjectMember).save([
        { projectId: id, userId: 'owner', role: 'owner' },
        { projectId: id, userId: 'admin', role: 'admin' },
        { projectId: id, userId: 'member', role: 'member' },
      ]);
    }
    const variables = new EnvironmentVariableService(database);
    const projects = new ProjectService(database);
    const global = await variables.create({ name: 'API_KEY', value: 'global' });
    const personal = await variables.create(
      { name: 'API_KEY', value: 'personal' },
      'owner',
    );
    const origin = 'http://localhost:5173';
    let user: { id: string; role: string } | undefined;
    const auth = {
      api: { getSession: async () => (user ? { user } : null) },
    } as unknown as Parameters<typeof createApp>[0];
    const localApi = new LocalApiAccess(`${origin}/api`, async () => true);
    const app = createApp(
      auth,
      undefined,
      { projects, localApi, webOrigin: origin } as NonNullable<
        Parameters<typeof createApp>[2]
      >,
      undefined,
      { service: variables, webOrigin: origin },
    );
    const client = createApiClient(
      () => `${origin}/api/rpc`,
    ).projectEnvironmentVariables;
    t.mock.method(globalThis, 'fetch', (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set('Origin', origin);
      return app.request(new Request(request, { headers }));
    });
    const path = `/api/projects/${projectId}/environment-variables`;
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    const params = { projectId };
    await assert.rejects(client.list({ params }), { code: 'UNAUTHORIZED' });
    assert.equal((await app.request(path)).status, 401);
    user = { id: 'owner', role: 'user' };
    assert.equal(
      (
        await app.request(path, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://other.example' },
          body: JSON.stringify({ name: 'API_KEY', value: 'bad' }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request(path, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: 'API_KEY',
            value: 'bad',
            projectId: otherId,
          }),
        })
      ).status,
      400,
    );
    const created = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'API_KEY',
        value: 'project',
        description: 'shared',
      }),
    });
    assert.equal(created.status, 201);
    const saved = (await created.json()) as { id: string; value: string };
    assert.equal(
      (await client.get({ params: { ...params, id: saved.id } })).value,
      'project',
    );
    const list = await app.request(path);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal((await list.json()).length, 1);
    await assert.rejects(
      client.create({ params, body: { name: 'API_KEY', value: 'duplicate' } }),
      { code: 'ENVIRONMENT_VARIABLE_CONFLICT' },
    );
    const other = await client.create({
      params: { projectId: otherId },
      body: { name: 'API_KEY', value: 'other-project' },
    });
    for (const id of [other.id, global.id, personal.id]) {
      for (const call of [
        () => client.get({ params: { ...params, id } }),
        () =>
          client.update({
            params: { ...params, id },
            body: { value: 'wrong' },
          }),
        () => client.remove({ params: { ...params, id } }),
      ])
        await assert.rejects(call(), {
          code: 'ENVIRONMENT_VARIABLE_NOT_FOUND',
        });
    }
    assert.deepEqual(await variables.list(), [global]);
    assert.deepEqual(await variables.list('owner'), [personal]);
    assert.deepEqual(await variables.getEnv(), { API_KEY: 'global' });
    assert.deepEqual(await variables.getEnv('owner'), { API_KEY: 'personal' });
    assert.deepEqual(await variables.getEnv('owner', projectId), {
      API_KEY: 'project',
    });
    assert.deepEqual(await variables.getEnv('member', projectId), {
      API_KEY: 'project',
    });
    assert.deepEqual(await variables.getEnv(undefined, projectId), {
      API_KEY: 'project',
    });
    assert.deepEqual(await variables.getEnv('owner', otherId), {
      API_KEY: 'other-project',
    });
    user = { id: 'admin', role: 'user' };
    await client.update({
      params: { ...params, id: saved.id },
      body: { value: '' },
    });
    assert.deepEqual(await variables.getEnv('owner', projectId), {
      API_KEY: '',
    });
    assert.equal(
      (await client.get({ params: { ...params, id: saved.id } })).description,
      'shared',
    );
    for (const [id, role, code, status] of [
      ['member', 'user', 'FORBIDDEN', 403],
      ['outsider', 'admin', 'PROJECT_NOT_FOUND', 404],
    ] as const) {
      user = { id, role };
      for (const call of [
        () => client.list({ params }),
        () => client.get({ params: { ...params, id: saved.id } }),
        () =>
          client.create({ params, body: { name: 'FORBIDDEN', value: 'no' } }),
        () =>
          client.update({
            params: { ...params, id: saved.id },
            body: { value: 'no' },
          }),
        () => client.remove({ params: { ...params, id: saved.id } }),
      ])
        await assert.rejects(call(), { code });
      const denied = await app.request(path);
      assert.equal(denied.status, status);
      assert.doesNotMatch(await denied.text(), /project|API_KEY/);
    }
    // Delegated credentials use the same project role check, regardless of cookie.
    const delegated = (id: string) => ({
      Authorization: `Bearer ${localApi.environment(id).APP_API_TOKEN}`,
    });
    assert.equal(
      (await app.request(path, { headers: delegated('admin') })).status,
      200,
    );
    assert.equal(
      (await app.request(path, { headers: delegated('member') })).status,
      403,
    );
    user = { id: 'owner', role: 'user' };
    await database.destroy();
    await database.initialize();
    assert.equal(
      (await client.get({ params: { ...params, id: saved.id } })).value,
      '',
    );
    await client.remove({ params: { ...params, id: saved.id } });
    assert.deepEqual(await variables.getEnv('owner', projectId), {
      API_KEY: 'personal',
    });
    assert.deepEqual(await variables.getEnv('member', projectId), {
      API_KEY: 'global',
    });
    // Both scopes may have the same name, but a record cannot belong to both.
    await assert.rejects(
      database.getRepository(EnvironmentVariable).insert({
        id: randomUUID(),
        userId: 'owner',
        projectId,
        name: 'INVALID_SCOPE',
        value: 'x',
      }),
    );
    const attempts = await Promise.allSettled([
      variables.create({ name: 'CONCURRENT', value: 'one' }, { projectId }),
      variables.create({ name: 'CONCURRENT', value: 'two' }, { projectId }),
    ]);
    assert.equal(
      attempts.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      attempts.find((result) => result.status === 'rejected')?.reason.code,
      'ENVIRONMENT_VARIABLE_CONFLICT',
    );
    await projects.changeMember('owner', projectId, 'admin', 'member');
    assert.equal(
      (await app.request(path, { headers: delegated('admin') })).status,
      403,
    );
    await projects.changeMember('owner', projectId, 'admin');
    assert.equal(
      (await app.request(path, { headers: delegated('admin') })).status,
      404,
    );
    await database.getRepository(Project).softDelete(projectId);
    assert.equal((await app.request(path)).status, 404);
    assert.deepEqual(await variables.getEnv('owner', projectId), {
      API_KEY: 'personal',
    });
    await database.getRepository(Project).delete(otherId);
    assert.equal(
      await database
        .getRepository(EnvironmentVariable)
        .countBy({ projectId: otherId }),
      0,
    );
  },
);
