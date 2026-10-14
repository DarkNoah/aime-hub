import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { BaseAgent } from '@aime/shared/agents';
import { buildAgent } from '../../mastra/agents/factory.js';
import { agentRegistry, getAgent } from '../../mastra/agents/index.js';

const definition = (
  id: string,
  overrides: Partial<BaseAgent> = {},
): BaseAgent => ({
  ...getAgent('code')!,
  id,
  name: id,
  instructions: `Instructions for ${id}`,
  ...overrides,
});

function register(t: TestContext, name: string, config: BaseAgent) {
  const registry = agentRegistry as Record<string, BaseAgent>;
  const previous = registry[name];
  registry[name] = config;
  t.after(() => {
    if (previous) registry[name] = previous;
    else delete registry[name];
  });
}

test('subagents resolve registration names and IDs, keep their prompts/tools, and use fresh instances', async (t) => {
  const leaf = definition('test:leaf', { disabledTools: ['curr_time'] });
  const child = definition('test:child', {
    agents: { leaf: leaf.id },
    disabledTools: ['sleep'],
  });
  register(t, 'testLeaf', leaf);
  register(t, 'testChild', child);
  const config = definition('test:parent', { agents: { worker: 'testChild' } });
  const model = new MastraLanguageModelV2Mock({});
  const memory = new Memory({ storage: new InMemoryStore() });
  const options = {
    model,
    memory,
    instructions: 'Parent override',
    defaultToolConfigs: { web_fetch: { enabled: false } },
  };
  const parent = buildAgent(config, options);
  const worker = (await parent.listAgents()).worker as Agent;
  assert.equal(worker.id, child.id);
  assert.deepEqual(await worker.listAgents(), {});
  assert.equal(await parent.getInstructions(), 'Parent override');
  assert.equal(await worker.getInstructions(), child.instructions);
  assert.equal((await worker.getModel()).modelId, model.modelId);
  assert.equal(await worker.getMemory(), memory);
  assert.equal((await worker.listTools()).sleep, undefined);
  assert.ok((await worker.listTools()).curr_time);
  assert.equal((await worker.listTools()).web_fetch, undefined);
  assert.deepEqual(getAgent('testChild')?.agents, { leaf: leaf.id });
  const byId = buildAgent({ ...config, agents: { worker: child.id } }, options);
  assert.equal((await byId.listAgents()).worker.id, child.id);
  assert.notEqual(
    (await buildAgent(config, options).listAgents()).worker,
    worker,
  );
});

test('main agent configuration rejects missing references and invalid tool names', () => {
  const options = { model: new MastraLanguageModelV2Mock({}) };
  const config = definition('test:parent');
  assert.throws(
    () =>
      buildAgent({ ...config, agents: { missing: 'not-registered' } }, options),
    /Unknown subagent/,
  );
  assert.throws(
    () =>
      buildAgent({ ...config, agents: { 'invalid name': 'code' } }, options),
    /Invalid subagent name/,
  );
});

test('self references and cycles across aliases produce children with no agents', async (t) => {
  const options = { model: new MastraLanguageModelV2Mock({}) };
  const config = definition('test:parent');
  const child = definition('test:child', { agents: { parent: config.id } });
  register(t, 'testParent', { ...config, agents: { worker: 'testChild' } });
  register(t, 'testChild', child);
  const parent = buildAgent(getAgent('testParent')!, options);
  assert.deepEqual(
    await ((await parent.listAgents()).worker as Agent).listAgents(),
    {},
  );
  const self = buildAgent(
    { ...config, agents: { self: 'testParent' } },
    options,
  );
  const selfChild = (await self.listAgents()).self as Agent;
  assert.equal(selfChild.id, config.id);
  assert.notEqual(selfChild, self);
  assert.deepEqual(await selfChild.listAgents(), {});
  const defaultAgent = buildAgent(getAgent('default')!, options);
  const defaultChild = (await defaultAgent.listAgents()).default as Agent;
  assert.equal(defaultChild.id, defaultAgent.id);
  assert.notEqual(defaultChild, defaultAgent);
  assert.deepEqual(await defaultChild.listAgents(), {});
});

test('fixed subagent models use the session resolver instead of silently using the parent model', async (t) => {
  const child = definition('test:fixed', { model: 'provider-id/model-id' });
  child.agents = { nested: 'testLeaf' };
  register(t, 'testLeaf', definition('test:leaf'));
  register(t, 'testFixed', child);
  const parentModel = new MastraLanguageModelV2Mock({});
  const childModel = new MastraLanguageModelV2Mock({ modelId: 'fixed-model' });
  const config = definition('test:parent', { agents: { worker: 'testFixed' } });
  assert.throws(
    () => buildAgent(config, { model: parentModel }),
    /needs subagentOptions/,
  );
  const agent = buildAgent(config, {
    model: parentModel,
    subagentOptions: (resolved) => {
      assert.equal(resolved.model, child.model);
      return { model: childModel, instructions: resolved.instructions };
    },
  });
  assert.equal(
    (await (await agent.listAgents()).worker.getModel()).modelId,
    childModel.modelId,
  );
  const worker = (await agent.listAgents()).worker as Agent;
  assert.deepEqual(await worker.listAgents(), {});
});

test('the default agent can delegate to its own leaf instance and finish a reply', async () => {
  const calls: string[] = [];
  const model = new MastraLanguageModelV2Mock({
    doGenerate: async (options) => {
      const parent = options.tools?.some(
        (tool) => tool.name === 'agent-default',
      );
      const first = calls.length === 0;
      calls.push(parent ? 'parent' : 'child');
      if (!parent)
        assert.equal(
          options.tools?.some((tool) => tool.name.startsWith('agent-')) ??
            false,
          false,
        );
      if (parent && !first)
        assert.match(JSON.stringify(options.prompt), /CHILD_RESULT/);
      return {
        content: first
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: 'delegate-self',
                toolName: 'agent-default',
                input: JSON.stringify({
                  prompt: 'Complete the delegated task',
                }),
              },
            ]
          : [
              {
                type: 'text' as const,
                text: parent ? 'DEFAULT_REPLY' : 'CHILD_RESULT',
              },
            ],
        finishReason: first ? ('tool-calls' as const) : ('stop' as const),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  const agent = buildAgent(getAgent('default')!, {
    model,
    memory: new Memory({
      storage: new InMemoryStore(),
      options: { generateTitle: false },
    }),
    buildTools: async () => ({}),
  });
  const result = await agent.generate('Delegate once, then reply', {
    memory: { thread: 'default-parent', resource: 'alice' },
    maxSteps: 3,
  });
  assert.equal(result.text, 'DEFAULT_REPLY');
  assert.deepEqual(calls, ['parent', 'child', 'parent']);
});

test('native Mastra delegation executes the child without delegation tools and isolates memory and request context', async (t) => {
  const child = definition('test:child', {
    agents: { self: 'testChild', missing: 'not-registered' },
  });
  register(t, 'testChild', child);
  const memory = new Memory({
    storage: new InMemoryStore(),
    options: { generateTitle: false, lastMessages: 10 },
  });
  const context = new RequestContext();
  context.set('userId', 'alice');
  const childModel = new MastraLanguageModelV2Mock({
    doGenerate: async (options) => {
      assert.equal(
        options.tools?.some((tool) => tool.name.startsWith('agent-')) ?? false,
        false,
      );
      assert.match(
        JSON.stringify(options.prompt),
        /Instructions for test:child/,
      );
      return {
        content: [{ type: 'text', text: 'CHILD_RESULT' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  let parentCalls = 0;
  const parentModel = new MastraLanguageModelV2Mock({
    doGenerate: async (options) => {
      parentCalls += 1;
      if (parentCalls === 1) {
        assert.ok(options.tools?.some((tool) => tool.name === 'agent-worker'));
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'delegate',
              toolName: 'agent-worker',
              input: JSON.stringify({ prompt: 'Do the delegated task' }),
            },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }
      assert.match(JSON.stringify(options.prompt), /CHILD_RESULT/);
      return {
        content: [{ type: 'text', text: 'PARENT_RESULT' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  const agent = buildAgent(
    definition('test:parent', { agents: { worker: 'testChild' } }),
    {
      model: parentModel,
      memory,
      buildTools: async () => ({}),
      subagentOptions: (config) => ({
        model: childModel,
        instructions: config.instructions,
        defaultOptions: ({ requestContext }) => {
          assert.equal(requestContext.get('userId'), 'alice');
          requestContext.set('childOnly', true);
          return {};
        },
      }),
    },
  );
  let delegatedThread: string | undefined;
  let delegatedResource: string | undefined;
  const result = await agent.generate('Delegate this request', {
    requestContext: context,
    memory: { thread: 'parent-thread', resource: 'alice' },
    maxSteps: 3,
    delegation: {
      onDelegationComplete: ({ success, result }) => {
        assert.equal(success, true);
        delegatedThread = result?.subAgentThreadId;
        delegatedResource = result?.subAgentResourceId;
      },
    },
  });
  assert.equal(result.text, 'PARENT_RESULT');
  assert.equal(parentCalls, 2);
  assert.equal(childModel.doGenerateCalls.length, 1);
  assert.equal(context.get('childOnly'), undefined);
  assert.ok(delegatedThread && delegatedResource);
  assert.notEqual(delegatedThread, 'parent-thread');
  const history = await memory.recall({
    threadId: delegatedThread,
    resourceId: delegatedResource,
  });
  assert.match(JSON.stringify(history.messages), /Do the delegated task/);
  assert.doesNotMatch(
    JSON.stringify(history.messages),
    /Delegate this request/,
  );
  assert.match(JSON.stringify(history.messages), /CHILD_RESULT/);
});
