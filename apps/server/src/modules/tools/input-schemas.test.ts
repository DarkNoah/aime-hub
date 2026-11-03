import assert from 'node:assert/strict';
import test from 'node:test';
import {
  standardSchemaToJSONSchema,
  toStandardSchema,
} from '@mastra/core/schema';
import type { PluginContext } from '@app/plugin-sdk/server';
import { buildTools } from './registry.js';
import {
  createGroupChatTools,
  createRoomManagementTool,
  type GroupChatAgentContext,
} from '../../mastra/tools/bot-agent.js';
import { createBacktestTools } from '../../../../../plugins/vibe-quant/mastra/tools/backtests.js';
import { createStrategyTools } from '../../../../../plugins/vibe-quant/mastra/tools/strategies.js';
import { createFactorTools } from '../../../../../plugins/vibe-quant/mastra/tools/factors.js';
import { createAutomationTools } from '../../mastra/tools/automations.js';
import { createSpeechTool } from '../../mastra/tools/speech.js';
import { createImageGenTool } from '../../mastra/tools/image_gen.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import { createKnowledgeTools } from '../../mastra/tools/knowledge.js';
import { commandLimits } from '../../mastra/tools/command/schema.js';
import { noopObserve, isValidationError } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';

const constraints = [
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
];
function assertSimple(schema: unknown, path: string) {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  for (const key of constraints)
    assert.equal(
      node[key],
      undefined,
      `${path}.${key} belongs in execution validation`,
    );
  assert.notEqual(
    node.type,
    'integer',
    `${path} should describe a number; validate integers during execution`,
  );
  for (const key of ['properties', '$defs', 'definitions', 'patternProperties'])
    if (node[key] && typeof node[key] === 'object')
      for (const [name, child] of Object.entries(node[key]))
        assertSimple(child, `${path}.${key}.${name}`);
  for (const key of [
    'items',
    'additionalProperties',
    'propertyNames',
    'not',
    'if',
    'then',
    'else',
  ])
    assertSimple(node[key], `${path}.${key}`);
  for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems'])
    if (Array.isArray(node[key]))
      node[key].forEach((child, i) =>
        assertSimple(child, `${path}.${key}[${i}]`),
      );
}

test('application and quant tools expose structural schemas without provider-sensitive validation constraints', async () => {
  const builtins = await buildTools([
    'automation_list',
    'automation_get',
    'automation_save',
    'automation_delete',
    'automation_run',
    'automation_history',
    'knowledge_list',
    'knowledge_create',
    'knowledge_get_document',
    'knowledge_archive_document',
    'knowledge_save_document',
    'knowledge_search',
    'exec',
    'exec_command',
    'write_stdin',
    'sleep',
    'read_file',
    'extract',
    'speech',
    'transcriptions',
    'image_gen',
    'web_search',
    'web_fetch',
    'intelligent_ui',
    'issue',
  ]);
  // Only construct schemas: no runtime services, permissions or remote calls are used.
  const context = {} as PluginContext;
  const get = () => {
    throw new Error('Schema construction must not resolve services');
  };
  const plugins = [
    ...createBacktestTools(context, get),
    ...createStrategyTools(context, get),
    ...createFactorTools(context, get),
  ];
  const room = {} as GroupChatAgentContext;
  const tools = [
    ...Object.values(builtins),
    ...Object.values(createGroupChatTools(room)),
    createRoomManagementTool(room),
    ...(await Promise.all(plugins.map((tool) => tool.getTools()))).flat(),
  ];
  assert.ok(tools.length > 50);
  for (const tool of tools) {
    assert.ok('id' in tool && 'inputSchema' in tool);
    assert.ok(tool.inputSchema, tool.id);
    assertSimple(
      standardSchemaToJSONSchema(toStandardSchema(tool.inputSchema), {
        io: 'input',
      }),
      String(tool.id),
    );
  }
});

test('relaxed tool schemas retain execution validation before services or scripts run', async () => {
  const requestContext = new RequestContext();
  requestContext.set('userId', 'alice');
  const context = { requestContext, observe: noopObserve };
  let resolutions = 0;
  const resolve = async () => {
    resolutions++;
    throw new Error('Invalid input must not reach a provider');
  };
  const speech = createSpeechTool(undefined, { resolveModel: resolve });
  for (const input of [
    { input: 'Hello' },
    { input: '', voice: 'alloy' },
    { input: 'Hello', voice: 'alloy', speed: 5 },
  ]) {
    assert.equal(
      (await speech.inputSchema!['~standard'].validate(input)).issues,
      undefined,
    );
    await assert.rejects(() => speech.execute!(input, context));
  }
  const image = createImageGenTool(undefined, { resolveModel: resolve });
  const imageResult = await image.execute!(
    { prompt: 'Image', ref_images: Array(5).fill('image.png') },
    context,
  );
  assert.ok(
    imageResult && !isValidationError(imageResult) && imageResult.isError,
  );
  assert.equal(resolutions, 0);
  const knowledge = createKnowledgeTools().knowledge_save_document;
  for (const input of [
    { item_id: '' },
    { name: '' },
    { source: '' },
    { expectedVersion: 0 },
  ]) {
    assert.equal(
      (await knowledge.inputSchema!['~standard'].validate(input)).issues,
      undefined,
    );
    await assert.rejects(
      () => knowledge.execute!({ action: 'save', ...input }, context),
      (error: unknown) =>
        error instanceof Error && !error.message.includes('unavailable'),
    );
  }
  const automation = createAutomationTools(() => {
    throw new Error('Invalid input must not resolve the automation service');
  }).automation_save;
  for (const input of [
    {},
    { id: '' },
    { id: 'task' },
    { name: 'Name', prompt: 'Prompt', cron: '0 9 * * *', ownerId: 'bob' },
  ]) {
    assert.equal(
      (await automation.inputSchema!['~standard'].validate(input)).issues,
      undefined,
    );
    await assert.rejects(
      () => automation.execute!(input, context),
      (error: unknown) =>
        error instanceof Error && !error.message.includes('must not resolve'),
    );
  }
  let catalogs = 0;
  const exec = createExecTool({
    getTools: async () => {
      catalogs++;
      return [];
    },
  });
  const result = await exec.execute!(
    {
      code: ' '.repeat(100001),
      yield_time_ms: 30000,
      max_output_tokens: 10000,
    },
    context,
  );
  assert.ok(result && !isValidationError(result) && result.isError);
  assert.equal(catalogs, 0);
  const capped = await exec.execute!(
    {
      code: 'text("x".repeat(60000))',
      yield_time_ms: 30000,
      max_output_tokens: 25000,
    },
    context,
  );
  assert.ok(capped && !isValidationError(capped));
  assert.equal(capped.truncated, true);
  assert.ok(
    capped.content.every(
      (part) => part.type !== 'text' || part.text.length <= 40000,
    ),
  );
  assert.deepEqual(commandLimits(249.5, -10), {
    yield_time_ms: 250,
    max_output_tokens: 1,
  });
  assert.deepEqual(commandLimits(30001, 100001), {
    yield_time_ms: 30000,
    max_output_tokens: 100000,
  });
});
