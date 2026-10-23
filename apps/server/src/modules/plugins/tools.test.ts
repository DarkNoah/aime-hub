import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DataSource } from 'typeorm';
import { createTool, noopObserve } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { PLUGIN_API_VERSION, pluginManifestSchema } from '@app/plugin-sdk';
import { PluginTool, type PluginServer } from '@app/plugin-sdk/server';
import { BaseTool, type ToolDependencies } from '@app/plugin-sdk/tools';
import { BaseTool as HostBaseTool, getTools } from '../tools/registry.js';
import { PluginService } from './service.js';
import { ListNotesTool } from '../../../../../plugins/notebook/server/tools/list-notes.js';

const id = 'plugin_example_probe';
const manifest = pluginManifestSchema.parse({
  id: 'example',
  name: 'Example',
  description: '',
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,
});

class ProbeTool extends PluginTool {
  constructions: ToolDependencies[] = [];
  executions = 0;

  constructor() {
    const tool = createTool({
      id,
      description: 'Probe tool',
      inputSchema: z.object({}),
      execute: async () => ++this.executions,
    });
    super(tool);
  }

  protected override create(_config: unknown, dependencies: ToolDependencies) {
    this.constructions.push(dependencies);
    return this.tool;
  }
}

async function fixture(t: TestContext) {
  const definition = new ProbeTool();
  let enabled = true;
  let saved: boolean | undefined;
  const query = async (sql: string) => {
    if (sql.includes('FROM plugin_installations'))
      return [
        { id: 'example', version: '1.0.0', enabled, revision: '1', config: {} },
      ];
    if (sql.includes('FROM plugin_migrations')) return [];
    if (sql.includes('FROM settings'))
      return saved === undefined
        ? []
        : [{ id: `tool:${id}`, value: { enabled: saved } }];
    if (sql.includes('pg_advisory_')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  };
  const database = {
    query,
    createQueryRunner: () => ({
      query,
      async connect() {},
      async release() {},
    }),
  } as unknown as DataSource;
  const plugin = {
    manifest,
    database: { entities: [], migrations: [] },
    createServer: () => ({ tools: [definition] }),
  };
  const service = new PluginService(database, [plugin]);
  t.after(() => service.dispose());
  await service.synchronize();
  return {
    definition,
    database,
    plugin,
    service,
    disable: () => {
      enabled = false;
    },
    save: (value: boolean) => {
      saved = value;
    },
  };
}

test('host and plugin definitions inherit the identical shared BaseTool', () => {
  assert.equal(BaseTool, HostBaseTool);
  assert.ok(new ProbeTool() instanceof BaseTool);
  assert.ok(new ListNotesTool(async () => []) instanceof BaseTool);
});

test('plugin registration rejects raw Mastra tools', async (t) => {
  const f = await fixture(t);
  const [raw] = await f.definition.getTools();
  assert.throws(
    () =>
      new PluginService(f.database, [
        {
          ...f.plugin,
          createServer: () => ({ tools: [raw] }) as unknown as PluginServer,
        },
      ]),
    /must extend PluginTool/,
  );
});

test('plugin configuration keeps persisted settings above caller defaults and plugin disable above both', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.tools({ [id]: { enabled: false } }), {});
  assert.equal(f.definition.constructions.length, 0);
  f.save(true);
  assert.ok((await f.service.tools({ [id]: { enabled: false } }))[id]);
  f.save(false);
  assert.deepEqual(await f.service.tools({ [id]: { enabled: true } }), {});
  f.save(true);
  f.disable();
  assert.deepEqual(await f.service.tools({ [id]: { enabled: true } }), {});
});

test('registry forwards Agent scope and excludes plugin tools before construction', async (t) => {
  const f = await fixture(t);
  const dependencies = {
    agentId: 'allowed',
    pluginTools: f.service.tools.bind(f.service),
    ownsPluginTool: f.service.ownsTool.bind(f.service),
  };
  assert.deepEqual(
    await getTools({}, dependencies, { ids: [id], onlyAgents: ['other'] }),
    [],
  );
  assert.deepEqual(
    await getTools({}, dependencies, { ids: [id], disabledTools: [id] }),
    [],
  );
  assert.deepEqual(await f.service.tools({}, {}, { ids: ['unselected'] }), {});
  assert.equal(f.definition.constructions.length, 0);
  const [tool] = await getTools({}, dependencies, {
    ids: [id],
    onlyAgents: ['allowed'],
  });
  assert.equal(f.definition.constructions[0].agentId, 'allowed');
  assert.ok(tool && 'execute' in tool && tool.execute);
  assert.equal(
    await tool.execute(
      {},
      { agent: { agentId: 'allowed' }, observe: noopObserve },
    ),
    1,
  );
  await assert.rejects(
    async () =>
      tool.execute!({}, { agent: { agentId: 'other' }, observe: noopObserve }),
    /unavailable to this Agent/,
  );
  assert.equal(f.definition.executions, 1);
  assert.deepEqual(
    Object.keys(await f.service.tools({}, {}, { onlyAgents: false })),
    [id],
  );
  assert.deepEqual(await f.service.tools({}, {}, { onlyAgents: [] }), {});
});

test('a constructed plugin handle rechecks enabled state without mutating the definition', async (t) => {
  const f = await fixture(t);
  const [original] = await f.definition.getTools();
  const tool = (await f.service.tools())[id];
  assert.notEqual(tool, original);
  assert.equal(Object.getPrototypeOf(tool), Object.getPrototypeOf(original));
  assert.ok('execute' in tool && tool.execute);
  assert.equal(await tool.execute({}, { observe: noopObserve }), 1);
  f.disable();
  await assert.rejects(
    async () => tool.execute!({}, { observe: noopObserve }),
    /PLUGIN_DISABLED/,
  );
  assert.equal(f.definition.executions, 1);
});

test('Notebook tool still scopes records to the authenticated author', async () => {
  const users: string[] = [];
  const definition = new ListNotesTool(async (userId) => {
    users.push(userId);
    return [
      {
        id: 'note',
        userId,
        title: 'Title',
        content: 'Body',
        slug: 'title',
        createdAt: new Date(),
      },
    ];
  });
  const [tool] = await definition.getTools();
  assert.ok(tool && 'execute' in tool && tool.execute);
  const requestContext = new RequestContext();
  requestContext.set('userId', 'alice');
  assert.deepEqual(
    await tool.execute({}, { requestContext, observe: noopObserve }),
    {
      notes: [{ id: 'note', title: 'Title', content: 'Body', slug: 'title' }],
    },
  );
  await assert.rejects(
    async () => tool.execute!({}, { observe: noopObserve }),
    /UNAUTHORIZED/,
  );
  assert.deepEqual(users, ['alice']);
});
