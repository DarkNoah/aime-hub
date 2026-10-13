import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createAuth, createAuthOptions } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import type { AutomationScope } from '@aime/shared/automations';
import type { ScheduleHooks } from '@mastra/core/schedules';
import { createApp } from '../../app.js';
import { createAutomationRuntime } from './runtime.js';

test(
  'automation list RPC uses the migrated auth schema and current user permissions without calling a model',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `automation_access_test_${randomBytes(8).toString('hex')}`;
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new Pool({ connectionString });
    const pool = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    const scheduleHooks: ScheduleHooks<Mastra> = {};
    const mastra = new Mastra({
      storage: new InMemoryStore(),
      logger: false,
      schedules: scheduleHooks,
    });
    const unexpected = async (): Promise<never> => {
      assert.fail('Listing automations must not resolve or execute a model');
    };
    const runtime = createAutomationRuntime({
      mastra,
      pool,
      scheduleHooks,
      workspaceRoot: '/unused-automation-list-workspace',
      agents: { getConfig: unexpected },
      models: { getLanguageModel: unexpected },
      projects: {
        assertMember: async () => ({ role: 'owner' }),
        get: unexpected,
      },
      tools: { buildTools: unexpected },
    });
    t.after(async () => {
      await runtime.shutdown();
      await mastra.shutdown();
      await pool.end();
      try {
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await root.end();
      }
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    const webOrigin = 'http://localhost:5173';
    const authConfig = {
      pool,
      secret: randomBytes(32).toString('hex'),
      webOrigin,
      admins: 'admin',
    };
    await (await getMigrations(createAuthOptions(authConfig))).runMigrations();
    const auth = createAuth(authConfig);
    const app = createApp(
      auth,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { service: runtime.service, webOrigin },
    );
    async function list(scope: AutomationScope, cookie: string) {
      const response = await app.request('/api/rpc/automations/list', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: webOrigin,
          cookie,
        },
        body: JSON.stringify({ json: scope }),
      });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await list({ scope: 'personal' }, '')).status, 401);
    for (const role of ['user', 'admin'] as const) {
      const username = `automation_${role}`;
      const password = randomBytes(24).toString('hex');
      const { user } = await auth.api.createUser({
        body: {
          name: username,
          email: `${username}@example.test`,
          password,
          role,
          data: { username },
        },
      });
      const login = await auth.api.signInUsername({
        body: { username, password },
        asResponse: true,
      });
      assert.equal(login.status, 200);
      const cookie = login.headers
        .getSetCookie()
        .map((item) => item.split(';')[0])
        .join('; ');
      for (const scope of [
        { scope: 'personal' },
        { scope: 'project', projectId: 'project000000001' },
        { scope: 'system' },
      ] satisfies AutomationScope[]) {
        const result = await list(scope, cookie);
        if (scope.scope === 'system' && role !== 'admin') {
          assert.equal(result.status, 403);
          assert.equal(result.body.json.code, 'FORBIDDEN');
        } else {
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.deepEqual(result.body.json, { items: [], canManage: true });
        }
      }
      await pool.query('UPDATE users SET banned = true WHERE id = $1', [
        user.id,
      ]);
      await assert.rejects(
        () => runtime.service.list(user.id, { scope: 'personal' }),
        { code: 'FORBIDDEN' },
      );
    }
    await assert.rejects(
      () => runtime.service.list('missing-user', { scope: 'personal' }),
      { code: 'FORBIDDEN' },
    );
  },
);
