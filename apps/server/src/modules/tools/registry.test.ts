import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTool,
  isValidationError,
  noopObserve,
  type ToolExecutionContext,
} from '@mastra/core/tools';
import {
  LocalFilesystem,
  Workspace,
  WORKSPACE_TOOLS,
} from '@mastra/core/workspace';
import { z } from 'zod';
import * as applicationTools from '../../mastra/tools/index.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import {
  buildTools,
  BaseTool,
  BuiltinTool,
  getTools,
  registeredToolIds,
  registerTools,
  toToolsInput,
  type ToolDependencies,
} from './registry.js';
import { toolSources } from './sources.js';

function fixtureTool(id: string) {
  return createTool({
    id,
    description: id,
    inputSchema: z.object({}),
    execute: async () => id,
  });
}

function agentContext(agentId: string): ToolExecutionContext {
  return {
    observe: noopObserve,
    agent: {
      agentId,
      toolCallId: 'test',
      messages: [],
      suspend: async () => {},
    },
  };
}

test('all application tools and dynamic sources inherit BaseTool; registration rejects duplicate IDs', () => {
  for (const definition of [...Object.values(applicationTools), ...toolSources])
    assert.ok(definition instanceof BaseTool);
  assert.deepEqual(
    registeredToolIds,
    Object.values(applicationTools).map((tool) => tool.id),
  );
  const tool = createTool({
    id: 'new_tool',
    description: 'New tool',
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });
  class ExampleTool extends BuiltinTool {
    protected override create() {
      return this.tool;
    }
  }
  const definition = new ExampleTool(tool);
  assert.equal(
    registerTools({ differentExportName: definition }).get('new_tool'),
    definition,
  );
  assert.throws(
    () => registerTools({ first: definition, second: definition }),
    /Duplicate tool ID: new_tool/,
  );
});

test('subclasses share configuration, selection and Agent restrictions without registry branches', async () => {
  class ExampleTool extends BuiltinTool {
    protected override create() {
      return this.tool;
    }
  }
  const native = fixtureTool('new_tool');
  const definition = new ExampleTool(native);
  let loads = 0;
  const dependencies: ToolDependencies = {
    agentId: 'allowed',
    loadConfig: async (id) => {
      assert.equal(id, native.id);
      loads++;
      return { enabled: true };
    },
  };
  const config = { new_tool: { enabled: false } };
  const [tool] = await definition.getTools(config, dependencies, {
    onlyAgents: ['allowed'],
  });
  assert.equal(tool.id, native.id, 'saved configuration overrides defaults');
  assert.equal(loads, 1);
  assert.deepEqual(
    await definition.getTools(config, dependencies, { onlyAgents: ['other'] }),
    [],
  );
  assert.deepEqual(
    await definition.getTools(config, dependencies, {
      disabledTools: [native.id],
    }),
    [],
  );
  assert.deepEqual(
    await definition.getTools(config, dependencies, { ids: ['unrelated'] }),
    [],
  );
  assert.equal(loads, 1, 'excluded tools do not load configuration');
  assert.deepEqual(await definition.getTools(config), []);
  assert.deepEqual(await definition.getTools(), [native]);
});

test('Agent exclusions override saved enabled settings and remain enforced inside exec', async () => {
  const disabledTools = ['curr_time', 'web_search'];
  const settings: Record<string, { enabled: boolean }> = {
    sleep: { enabled: false },
  };
  const tools = await buildTools(
    undefined,
    {},
    {
      disabledTools,
      loadConfig: async (id) => settings[id] ?? { enabled: true },
    },
  );
  for (const id of [...disabledTools, 'sleep'])
    assert.equal(id in tools, false);
  assert.ok('web_fetch' in tools);
  const exec = tools.exec as ReturnType<typeof createExecTool>;
  // Global changes apply to the catalog rebuilt at invocation time, too.
  settings.web_fetch = { enabled: false };
  const result = await exec.execute!(
    {
      code: 'text(ALL_TOOLS.map(t => t.name)); text([typeof tools.curr_time, typeof tools.web_search, typeof tools.web_fetch, typeof tools.sleep]);',
      yield_time_ms: 3000,
      max_output_tokens: 1000,
    },
    { observe: noopObserve },
  );
  assert.ok(result && !isValidationError(result) && !result.isError);
  const output = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text);
  const catalog: string[] = JSON.parse(output[0]);
  assert.ok(catalog.includes('task_check'));
  for (const id of [...disabledTools, 'sleep', 'web_fetch', 'exec'])
    assert.ok(!catalog.includes(id));
  assert.deepEqual(JSON.parse(output[1]), [
    'undefined',
    'undefined',
    'undefined',
    'undefined',
  ]);
  assert.equal(
    'exec' in (await buildTools(undefined, {}, { disabledTools: ['exec'] })),
    false,
  );
});

test('one array includes application, plugin, MCP, workspace and browser tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'registry-sources-'));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: root }),
  });
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const plugin = fixtureTool('plugin_sample_tool');
  const nativeMcp = fixtureTool('native_mcp_name');
  const browserTool = fixtureTool('browser_action');
  const tools = await getTools(
    {},
    {
      pluginTools: async () => ({ [plugin.id]: plugin }),
      mcpTools: async () => ({ mcp__sample__action: nativeMcp }),
      context: {
        workspace,
        browser: {
          getTools: () => ({ browser_action: browserTool }),
        } as unknown as ToolExecutionContext['browser'],
      },
    },
  );
  assert.ok(Array.isArray(tools));
  const catalog = toToolsInput(tools);
  for (const id of [
    'curr_time',
    plugin.id,
    'mcp__sample__action',
    browserTool.id,
    WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  ])
    assert.ok(catalog[id], id);
  assert.equal(tools.length, new Set(tools.map((tool) => tool.id)).size);
  assert.equal(catalog[plugin.id], plugin);
  const mcp = tools.find((tool) => tool.id === 'mcp__sample__action')!;
  assert.ok('inputSchema' in mcp && 'execute' in mcp);
  assert.equal(Object.getPrototypeOf(mcp), Object.getPrototypeOf(nativeMcp));
  assert.equal(mcp.inputSchema, nativeMcp.inputSchema);
  assert.equal(mcp.execute, nativeMcp.execute);
  assert.equal(nativeMcp.id, 'native_mcp_name');
});

test('onlyAgents false allows all Agents; IDs restrict discovery and execution', async () => {
  let discoveries = 0;
  const plugin = fixtureTool('plugin_sample_tool');
  const dependencies: ToolDependencies = {
    pluginTools: async () => {
      discoveries++;
      return { [plugin.id]: plugin };
    },
  };
  for (const agentId of [undefined, 'code:assistant', 'other']) {
    const tools = await getTools(
      {},
      { ...dependencies, agentId },
      { onlyAgents: false, ids: [plugin.id] },
    );
    assert.equal(tools[0], plugin);
  }
  discoveries = 0;
  for (const onlyAgents of [[], ['code:assistant']]) {
    for (const agentId of [undefined, 'other']) {
      assert.deepEqual(
        await getTools({}, { ...dependencies, agentId }, { onlyAgents }),
        [],
      );
    }
  }
  assert.equal(discoveries, 0, 'excluded Agents must not load any tool source');
  const [scoped] = await getTools(
    {},
    { ...dependencies, agentId: 'code:assistant' },
    {
      onlyAgents: ['code:assistant'],
      ids: [plugin.id],
    },
  );
  assert.ok('execute' in scoped && scoped.execute);
  assert.equal(
    await scoped.execute({}, agentContext('code:assistant')),
    plugin.id,
  );
  await assert.rejects(
    async () => scoped.execute!({}, agentContext('other')),
    /unavailable to this Agent/,
  );
  assert.equal(
    await plugin.execute!({}, agentContext('other')),
    plugin.id,
    'shared instances are not mutated',
  );
  assert.deepEqual(
    await getTools(
      {},
      {
        ...dependencies,
        agentId: 'code:assistant',
        context: agentContext('other'),
      },
      {
        onlyAgents: ['code:assistant'],
      },
    ),
    [],
    'execution identity overrides the construction identity',
  );
  assert.equal(
    (
      await getTools(
        {},
        { ...dependencies, context: agentContext('code:assistant') },
        {
          onlyAgents: ['code:assistant'],
          ids: [plugin.id],
        },
      )
    ).length,
    1,
  );
});

test('selection preserves order and aliases; exclusions apply across sources', async () => {
  const plugin = fixtureTool('plugin_sample_tool');
  const mcp = fixtureTool('mcp__sample__action');
  const browser = fixtureTool('browser_action');
  const dependencies: ToolDependencies = {
    pluginTools: async () => ({ [plugin.id]: plugin }),
    mcpTools: async () => ({ [mcp.id]: mcp }),
    ownsPluginTool: (id) => id === 'plugin_sample_disabled',
    context: {
      browser: {
        getTools: () => ({ [browser.id]: browser }),
      } as ToolExecutionContext['browser'],
    },
  };
  assert.deepEqual(
    (
      await getTools({}, dependencies, {
        ids: [mcp.id, 'view_file', plugin.id, 'read_file', 'curr_time'],
      })
    ).map((tool) => tool.id),
    [mcp.id, 'read_file', plugin.id, 'curr_time'],
  );
  assert.deepEqual(
    await getTools({}, dependencies, { ids: ['plugin_sample_disabled'] }),
    [],
  );
  assert.deepEqual(await getTools({}, dependencies, { ids: [] }), []);
  const excluded = ['view_file', plugin.id, mcp.id, browser.id];
  const tools = await getTools({}, dependencies, { disabledTools: excluded });
  for (const id of ['read_file', ...excluded])
    assert.ok(!tools.some((tool) => tool.id === id));
  await assert.rejects(
    getTools({}, dependencies, { ids: ['missing'] }),
    /Unknown tool ID: missing/,
  );
});

test('duplicate source IDs fail without silently replacing an existing tool', async () => {
  const tool = fixtureTool('curr_time');
  await assert.rejects(
    getTools({}, { pluginTools: async () => ({ curr_time: tool }) }),
    /Duplicate tool ID: curr_time/,
  );
  assert.throws(
    () => toToolsInput([tool, tool]),
    /Duplicate tool ID: curr_time/,
  );
});

test('exec refreshes dynamic sources, keeps Agent scope and filters filesystem imports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'registry-exec-'));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: root }),
  });
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'file.txt'), 'original');
  let discoveries = 0;
  let enabled = true;
  const plugin = fixtureTool('plugin_sample_tool');
  const mcp = fixtureTool('mcp__sample__action');
  const [tool] = await getTools(
    {},
    {
      agentId: 'allowed',
      pluginTools: async () => (enabled ? { [plugin.id]: plugin } : {}),
      mcpTools: async () => {
        discoveries++;
        return { [mcp.id]: mcp };
      },
    },
    {
      ids: ['exec'],
      onlyAgents: ['allowed'],
      includeRuntimeTools: false,
      disabledTools: [mcp.id, WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE],
    },
  );
  assert.equal(discoveries, 0, 'Agent construction must defer MCP discovery');
  const exec = tool as ReturnType<typeof createExecTool>;
  const run = (code: string) =>
    exec.execute!(
      { code, yield_time_ms: 3000, max_output_tokens: 1000 },
      { ...agentContext('allowed'), workspace },
    );
  const first = await run(
    'text([typeof tools.plugin_sample_tool, typeof tools.mcp__sample__action, typeof tools.exec]);',
  );
  assert.ok(first && !isValidationError(first) && !first.isError);
  assert.deepEqual(first.content, [
    { type: 'text', text: '["function","undefined","undefined"]' },
  ]);
  enabled = false;
  const second = await run('text(typeof tools.plugin_sample_tool);');
  assert.ok(second && !isValidationError(second) && !second.isError);
  assert.deepEqual(second.content, [{ type: 'text', text: 'undefined' }]);
  assert.equal(discoveries, 2);
  const denied = await run(
    "import fs from 'node:fs/promises'; await fs.writeFile('file.txt', 'changed');",
  );
  assert.ok(denied && !isValidationError(denied) && denied.isError);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'original');
  await assert.rejects(
    async () =>
      exec.execute!(
        {
          code: 'text("denied");',
          yield_time_ms: 3000,
          max_output_tokens: 1000,
        },
        agentContext('other'),
      ),
    /unavailable to this Agent/,
  );
});
