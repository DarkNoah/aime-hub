import assert from 'node:assert/strict';
import test from 'node:test';
import { createTool, isValidationError, noopObserve } from '@mastra/core/tools';
import { z } from 'zod';
import * as applicationTools from '../../mastra/tools/index.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import { buildTools, registeredToolIds, registerTools } from './registry.js';

test('exported tools register by their own ID and duplicate IDs fail fast', () => {
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
  assert.equal(
    registerTools({ differentExportName: tool }).get('new_tool'),
    tool,
  );
  assert.throws(
    () => registerTools({ first: tool, second: tool }),
    /Duplicate tool ID: new_tool/,
  );
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
