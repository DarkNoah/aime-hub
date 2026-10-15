import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { config } from 'dotenv';
import { createDataSource } from '@aime/db';
import { createAuthOptions, type Auth } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { RequestContext } from '@mastra/core/request-context';
import { pluginManifestSchema } from '@app/plugin-sdk';
import type { InstalledPlugin } from '@app/plugin-sdk/server';
import { PluginService } from './service.js';
import { migratePlugins } from './migrations.js';
import { pluginRoutes } from './routes.js';
import { syncBuiltinSkills } from '../skills/builtin.js';
import { registerPluginSkillAccess } from './skill-access.js';
import { discoverInstalledSkills } from '../threads/workspace.js';
import { listChatSkills, resolveAgentSkillPaths } from '../threads/skills.js';
import { directorySkillConfig } from '../threads/skill-source.js';
import { ToolService } from '../tools/service.js';
import { AgentService } from '../agents/service.js';
import { SkillService } from '../skills/service.js';
import { PostgresStore } from '@mastra/pg';

const enabled = process.env.PLUGIN_INTEGRATION === '1';
test(
  'full-stack plugin PostgreSQL lifecycle, authorization and AI integration',
  { skip: !enabled },
  async () => {
    // Test the demo independently of its deployment discovery switch. Variable URLs keep
    // its disabled source out of the host's static import/typecheck graph.
    const notebookRoot = new URL(
      '../../../../../plugins/notebook/',
      import.meta.url,
    );
    const [serverModule, databaseModule, manifest] = await Promise.all([
      import(new URL('server/index.ts', notebookRoot).href),
      import(new URL('server/database.ts', notebookRoot).href),
      readFile(new URL('plugin.manifest.json', notebookRoot), 'utf8').then(
        JSON.parse,
      ),
    ]);
    const installedPlugins: InstalledPlugin[] = [
      {
        manifest: pluginManifestSchema.parse({ ...manifest, enabled: true }),
        createServer: serverModule.default,
        database: databaseModule.default,
      },
    ];
    config({ quiet: true });
    const source = new URL(process.env.DATABASE_URL!);
    const databaseName = `plugin_test_${process.pid}_${Date.now()}`;
    const admin = new Pool({ connectionString: source.href });
    let created = false;
    const root = await mkdtemp(join(tmpdir(), 'plugin-integration-'));
    let unregister = () => {};
    let database: ReturnType<typeof createDataSource> | undefined;
    let pool: Pool | undefined;
    let skills: SkillService | undefined;
    let storage: PostgresStore | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      source.pathname = `/${databaseName}`;
      pool = new Pool({ connectionString: source.href });
      const options = createAuthOptions({
        pool,
        secret: 'plugin-integration-secret-at-least-32-chars',
        webOrigin: ['http://localhost:5173'],
        admins: '',
      });
      await (await getMigrations(options)).runMigrations();
      database = createDataSource(
        source.href,
        installedPlugins.flatMap((p) => p.database.entities),
      );
      await database.initialize();
      await database.runMigrations();
      assert.equal(await migratePlugins(database, []), 0);
      assert.equal(
        (
          await database.query(
            "SELECT to_regclass('public.plugin_notebook_notes') AS name",
          )
        )[0].name,
        null,
      );
      assert.deepEqual(
        await database.query('SELECT id FROM plugin_installations'),
        [],
      );
      assert.equal(await migratePlugins(database, installedPlugins), 1);
      assert.equal(
        await migratePlugins(database, installedPlugins),
        0,
        'migrations are idempotent',
      );
      await pool.query(`INSERT INTO users(id, name, email, email_verified, created_at, updated_at, role) VALUES
      ('admin', 'Admin', 'admin@plugin.test', true, now(), now(), 'admin'),
      ('alice', 'Alice', 'alice@plugin.test', true, now(), now(), 'user'),
      ('bob', 'Bob', 'bob@plugin.test', true, now(), now(), 'user')`);
      const service = new PluginService(database, installedPlugins);
      const otherProcess = new PluginService(database, installedPlugins);
      const auth = {
        api: {
          getSession: async ({ headers }: { headers: Headers }) => {
            const id = headers.get('x-test-user');
            return ['admin', 'alice', 'bob'].includes(id ?? '')
              ? {
                  user: { id, role: id === 'admin' ? 'admin' : 'user' },
                  session: { id },
                }
              : null;
          },
        },
      } as unknown as Auth;
      const api = pluginRoutes(auth, service, ['http://localhost:5173']);
      const request = (
        path: string,
        user = 'admin',
        method = 'GET',
        body?: unknown,
        origin = 'http://localhost:5173',
      ) =>
        api.request(path, {
          method,
          headers: {
            'x-test-user': user,
            'content-type': 'application/json',
            origin,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      assert.equal((await request('/', '')).status, 401);
      assert.equal(
        (await request('/notebook/enabled', 'alice', 'PUT', { enabled: true }))
          .status,
        403,
      );
      assert.equal(
        (
          await request(
            '/notebook/enabled',
            'admin',
            'PUT',
            { enabled: true },
            'https://evil.test',
          )
        ).status,
        403,
      );
      assert.equal((await request('/notebook/notes', 'alice')).status, 404);
      assert.equal(
        (await request('/notebook/enabled', 'admin', 'PUT', { enabled: true }))
          .status,
        200,
      );
      assert.equal(
        (await otherProcess.list())[0].enabled,
        true,
        'state visible to another runtime',
      );
      const saved = await request('/notebook/notes', 'alice', 'POST', {
        title: 'Hello Plugin',
        content: 'Private Alice note',
      });
      assert.equal(saved.status, 201);
      const note = await saved.json();
      assert.equal(
        note.slug,
        'hello-plugin',
        'plugin-local dependency executes',
      );
      assert.equal(
        (
          await request('/notebook/notes', 'alice', 'POST', {
            title: 'x',
            content: 'x',
            userId: 'bob',
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request('/notebook/notes', 'alice', 'POST', {
            title: ' ',
            content: 'x',
          })
        ).status,
        400,
      );
      assert.deepEqual(
        await (await request('/notebook/notes', 'bob')).json(),
        [],
      );
      assert.equal(
        (await request(`/notebook/notes/${note.id}`, 'bob', 'DELETE')).status,
        404,
      );
      assert.equal(
        (await (await request('/notebook/notes', 'alice')).json()).length,
        1,
      );
      const skillSource = join(root, 'bundled-skills');
      await mkdir(skillSource);
      await cp(
        new URL('skills/', notebookRoot),
        join(skillSource, 'notebook'),
        { recursive: true },
      );
      await syncBuiltinSkills(skillSource, root, 'plugins');
      unregister = registerPluginSkillAccess(
        root,
        async () =>
          new Set(
            (await service.list()).filter((p) => p.enabled).map((p) => p.id),
          ),
      );
      const discovered = await discoverInstalledSkills(root);
      assert.equal(discovered.length, 1);
      assert.equal(
        (await listChatSkills(root, 'alice'))[0].name,
        'notebook-guide',
      );
      skills = new SkillService(root);
      assert.equal((await skills.list()).skills.length, 1);
      await assert.rejects(skills.remove('plugins/notebook/notebook-guide'));
      storage = new PostgresStore({
        id: 'plugin-test',
        pool,
        schemaName: 'mastra',
      });
      await storage.init();
      const agentStore = await storage.getStore('agents');
      assert.ok(agentStore);
      const providers = {} as ConstructorParameters<typeof ToolService>[1] &
        ConstructorParameters<typeof AgentService>[3];
      const tools = new ToolService(
        database,
        providers,
        undefined,
        undefined,
        service,
      );
      const agents = new AgentService(
        agentStore,
        skills,
        tools,
        providers,
        undefined,
        service,
      );
      assert.ok(
        (await agents.list()).some((a) => a.id === 'plugin:notebook:assistant'),
      );
      const agent = await agents.getConfig('plugin:notebook:assistant');
      assert.equal(
        (await resolveAgentSkillPaths(root, 'alice', agent)).length,
        1,
      );
      const built = await tools.buildTools();
      assert.equal(
        (
          await tools.buildTools(undefined, {
            plugin_notebook_list_notes: { enabled: false },
          })
        ).plugin_notebook_list_notes,
        undefined,
      );
      assert.equal(
        (await tools.buildTools(undefined, {}, ['plugin_notebook_list_notes']))
          .plugin_notebook_list_notes,
        undefined,
      );
      await tools.setEnabled('plugin_notebook_list_notes', true);
      assert.ok(
        (
          await tools.buildTools(undefined, {
            plugin_notebook_list_notes: { enabled: false },
          })
        ).plugin_notebook_list_notes,
        'saved configuration overrides caller defaults',
      );
      const tool = built.plugin_notebook_list_notes;
      assert.ok(tool && 'execute' in tool && tool.execute);
      const userContext = new RequestContext();
      userContext.set('userId', 'alice');
      // Exercise the actual guarded Tool instance through its Mastra execute contract.
      const output = (await tool.execute({}, {
        requestContext: userContext,
      } as never)) as { notes: { title: string }[] };
      assert.equal(output.notes[0].title, 'Hello Plugin');
      const bobContext = new RequestContext();
      bobContext.set('userId', 'bob');
      assert.deepEqual(
        (
          (await tool.execute({}, { requestContext: bobContext } as never)) as {
            notes: unknown[];
          }
        ).notes,
        [],
      );
      const exec = built.exec;
      assert.ok(exec && 'execute' in exec && exec.execute);
      const execOutput = await exec.execute(
        {
          code: 'text(await tools.plugin_notebook_list_notes({}));',
          yield_time_ms: 5000,
          max_output_tokens: 1000,
        },
        { requestContext: userContext } as never,
      );
      assert.match(JSON.stringify(execOutput), /Hello Plugin/);
      let modelCalls = 0;
      const model = new MastraLanguageModelV2Mock({
        doGenerate: async (options) => {
          const first = modelCalls++ === 0;
          if (!first)
            assert.match(JSON.stringify(options.prompt), /Private Alice note/);
          return {
            content: first
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'read-notes',
                    toolName: 'plugin_notebook_list_notes',
                    input: '{}',
                  },
                ]
              : [{ type: 'text' as const, text: 'Your note: Hello Plugin' }],
            finishReason: first ? ('tool-calls' as const) : ('stop' as const),
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        },
      });
      const runtimeAgent = await agents.getAgent(agent.id, {
        model,
        buildTools: tools.buildTools.bind(tools),
      });
      const reply = await runtimeAgent.generate('Read my notes', {
        requestContext: userContext,
        maxSteps: 3,
      });
      assert.equal(reply.text, 'Your note: Hello Plugin');
      assert.equal(modelCalls, 2);
      assert.equal(runtimeAgent.id, agent.id);
      assert.equal(
        (await request('/notebook/enabled', 'admin', 'PUT', { enabled: false }))
          .status,
        200,
      );
      assert.equal((await otherProcess.list())[0].enabled, false);
      assert.equal((await request('/notebook/notes', 'alice')).status, 404);
      assert.equal(
        (await agents.list()).some((a) => a.id === agent.id),
        false,
      );
      await assert.rejects(agents.getConfig(agent.id));
      assert.equal(
        (await tools.buildTools()).plugin_notebook_list_notes,
        undefined,
      );
      await assert.rejects(
        tool.execute({}, { requestContext: userContext } as never),
        /PLUGIN_DISABLED/,
        'old handles must recheck state',
      );
      assert.deepEqual(await discoverInstalledSkills(root), []);
      assert.deepEqual((await skills.list()).skills, []);
      await assert.rejects(
        directorySkillConfig([discovered[0].path]).skillSource.readFile(
          join(discovered[0].path, 'SKILL.md'),
        ),
        /PLUGIN_DISABLED/,
      );
      await service.setEnabled('notebook', true);
      assert.equal(
        (await (await request('/notebook/notes', 'alice')).json()).length,
        1,
        'disable preserves data',
      );
      const restarted = new PluginService(database, installedPlugins);
      // Removing a plugin from discovery hides even an existing enabled installation;
      // it does not delete that plugin's data or its saved activation choice.
      const excluded = new PluginService(database, []);
      assert.deepEqual(await excluded.list(), []);
      const excludedApi = pluginRoutes(auth, excluded, [
        'http://localhost:5173',
      ]);
      const excludedHeaders = {
        'x-test-user': 'admin',
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      };
      assert.deepEqual(
        await (
          await excludedApi.request('/', { headers: excludedHeaders })
        ).json(),
        [],
      );
      assert.equal(
        (
          await excludedApi.request('/notebook/notes', {
            headers: excludedHeaders,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await excludedApi.request('/notebook/enabled', {
            method: 'PUT',
            headers: excludedHeaders,
            body: JSON.stringify({ enabled: true }),
          })
        ).status,
        404,
      );
      assert.equal(await migratePlugins(database, []), 0);
      assert.equal(
        (
          await database.query(
            'SELECT enabled FROM plugin_installations WHERE id = $1',
            ['notebook'],
          )
        )[0].enabled,
        true,
      );
      assert.equal(
        (
          await database.query(
            'SELECT count(*)::int AS count FROM plugin_notebook_notes',
          )
        )[0].count,
        1,
      );
      const emptySkills = join(root, 'empty-skills');
      await mkdir(emptySkills);
      await syncBuiltinSkills(emptySkills, root, 'plugins');
      assert.equal((await skills.list()).skills.length, 0);
      await excluded.dispose();
      assert.equal((await restarted.list())[0].enabled, true);
      const failing = {
        ...installedPlugins[0],
        manifest: { ...installedPlugins[0].manifest, id: 'broken' },
        database: {
          entities: [],
          migrations: [
            class BrokenMigration {
              async up(runner: import('typeorm').QueryRunner) {
                await runner.query('CREATE TABLE plugin_broken_rows (id text)');
                throw new Error('migration failure');
              }
              async down() {}
            },
          ],
        },
      };
      await assert.rejects(
        migratePlugins(database, [failing]),
        /migration failure/,
      );
      assert.equal(
        (
          await database.query(
            "SELECT to_regclass('plugin_broken_rows') AS table",
          )
        )[0].table,
        null,
      );
      assert.equal(
        (
          await database.query(
            "SELECT * FROM plugin_migrations WHERE plugin_id = 'broken'",
          )
        ).length,
        0,
      );
      const dependent = {
        manifest: {
          ...installedPlugins[0].manifest,
          id: 'dependent',
          dependencies: ['notebook'],
        },
        database: { entities: [], migrations: [] },
        createServer: () => ({}),
      };
      await migratePlugins(database, [dependent]);
      const withDependency = new PluginService(database, [
        ...installedPlugins,
        dependent,
      ]);
      await withDependency.setEnabled('dependent', true);
      await assert.rejects(
        withDependency.setEnabled('notebook', false),
        /PLUGIN_HAS_DEPENDENTS/,
      );
      await withDependency.setEnabled('dependent', false);
      await withDependency.setEnabled('notebook', false);
      await assert.rejects(
        withDependency.setEnabled('dependent', true),
        /PLUGIN_DEPENDENCY_DISABLED/,
      );
      await withDependency.dispose();
      const upgraded = {
        ...installedPlugins[0],
        manifest: { ...installedPlugins[0].manifest, version: '2.0.0' },
      };
      await migratePlugins(database, [upgraded]);
      assert.equal((await service.list())[0].ready, false);
      await assert.rejects(
        migratePlugins(database, installedPlugins),
        /PLUGIN_DOWNGRADE_UNSUPPORTED/,
      );
      await restarted.dispose();
      await otherProcess.dispose();
      await service.dispose();
    } finally {
      unregister();
      await skills?.dispose();
      await storage?.close();
      if (database?.isInitialized) await database.destroy();
      if (pool && !pool.ended) await pool.end();
      if (created)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
