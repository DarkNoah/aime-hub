import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import type { Agent, ToolsInput } from '@mastra/core/agent';
import type { AgentRuntimeOptions } from '../../mastra/agents/factory.js';
import {
  getTools,
  registeredToolIds,
  parseToolConfig,
} from '../tools/registry.js';
import {
  NON_INTERACTIVE_TOOLS_CONTEXT,
  guardNonInteractiveTool,
  nonInteractiveTools,
} from '../tools/non-interactive.js';
import { createGroupChatAgent } from '../../mastra/agents/group-chat.js';
import {
  createGroupChatTools,
  BotAgentTools,
  type GroupChatAgentContext,
} from '../../mastra/tools/bot-agent.js';
import { botAgent } from '../../mastra/agents/bot-agent.js';

function execution(signal?: AbortSignal) {
  return {
    requestContext: new RequestContext(),
    abortSignal: signal,
    agent: { toolCallId: 'native-call-1' },
  } as ToolExecutionContext;
}

function invoke(
  tool: ToolsInput[string],
  input: unknown,
  runtime = execution(),
) {
  return (
    tool as {
      execute: (
        input: unknown,
        runtime: ToolExecutionContext,
      ) => Promise<unknown>;
    }
  ).execute(input, runtime);
}

function fixture() {
  const calls: { operation: string; args: unknown[] }[] = [];
  const message = Object.freeze({
    id: 'message000000001',
    roomId: 'room000000000001',
    sequence: '7',
    revision: '9',
    senderId: 'owner',
    senderKind: 'user' as const,
    senderName: '王小明',
    senderUsername: 'xiaoming',
    text: 'Please review the report.',
    replyToId: null,
    files: [],
    ui: null,
    uiResponse: null,
    targetAgentId: null,
    reactions: [],
    createdAt: '2026-10-30T00:00:00Z',
  });
  const record =
    (operation: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ operation, args });
      return result;
    };
  const context: GroupChatAgentContext = {
    roomId: 'room000000000001',
    memberId: 'member0000000001',
    threadId: 'thread0000000001',
    userId: 'owner',
    role: 'bot',
    memoryPath: '/share/.agents/room/MEMORY.md',
    service: {
      getAgent: record('getAgent', {
        enabled: true,
        threadId: 'thread0000000001',
      }),
      get: record('get', {
        id: 'room000000000001',
        agents: [{ id: 'worker0000000001', name: 'Researcher' }],
      }),
      sendAgent: record('sendAgent', message),
      react: record('react', message),
      messages: record('messages', {
        messages: [message],
        hasMore: false,
        revision: '9',
      }),
      recentMessages: record('recentMessages', {
        messages: [message],
        hasMore: false,
        revision: '9',
      }),
      search: record('search', {
        messages: [{ ...message, score: 2.5 }],
        hasMore: false,
      }),
      createPlan: record('createPlan', { id: 'plan000000000001' }),
    } as unknown as GroupChatAgentContext['service'],
  };
  return { calls, context, message, tools: createGroupChatTools(context) };
}

test('query tools omit roomId while retaining names, pagination and search scores without mutating messages', async () => {
  const { tools, message } = fixture();
  for (const name of [
    'get_room_messages',
    'get_room_recent_messages',
    'search_room_messages',
  ] as const) {
    const page = (await invoke(
      tools[name],
      name === 'search_room_messages' ? { query: 'report' } : {},
    )) as {
      messages: Record<string, unknown>[];
      hasMore: boolean;
      revision?: string;
    };
    const result = page.messages[0];
    assert.equal(Object.hasOwn(result, 'roomId'), false);
    assert.equal(page.hasMore, false);
    assert.deepEqual(
      { ...result, roomId: message.roomId },
      name === 'search_room_messages' ? { ...message, score: 2.5 } : message,
    );
    if (name !== 'search_room_messages') assert.equal(page.revision, '9');
  }
  assert.equal(message.roomId, 'room000000000001');
});

test('search tool accepts reaction-only filters and the bot instructions encourage bookmarks', async () => {
  const { tools, calls } = fixture();
  await invoke(tools.search_room_messages, { reactions: ['⭐', '✅'] });
  const search = calls.find((call) => call.operation === 'search')!;
  assert.deepEqual(search.args[2], {
    query: undefined,
    reactions: ['⭐', '✅'],
    limit: 50,
  });
  assert.match(botAgent.description!, /reaction/);
  assert.match(String(botAgent.instructions), /⭐/);
});

test('send_message returns only a plain-text message ID for every successful action', async () => {
  const { tools, message } = fixture();
  for (const input of [
    { action: 'send', text: 'Hello' },
    { action: 'reply', text: 'Reply', messageId: message.id },
    { action: 'reaction', messageId: message.id, emoji: '👍' },
    { action: 'file', files: [{ path: 'report.pdf', name: 'Report' }] },
    { action: 'send', text: '@Researcher Review this report' },
  ]) {
    assert.equal(await invoke(tools.send_message, input), message.id);
  }
});

test('room catalogs exclude all declared suspend/resume and approval capabilities', () => {
  const regular = createTool({
    id: 'regular',
    description: 'regular',
    execute: async () => 'ok',
  });
  const suspended = createTool({
    id: 'suspended',
    description: 'suspend',
    suspendSchema: z.object({}),
    execute: async () => 'no',
  });
  const resume = createTool({
    id: 'resume',
    description: 'resume',
    resumeSchema: z.object({}),
    execute: async () => 'no',
  });
  const approval = createTool({
    id: 'approval',
    description: 'approval',
    requireApproval: true,
    execute: async () => 'no',
  });
  const conditional = createTool({
    id: 'conditional',
    description: 'conditional',
    requireApproval: () => false,
    execute: async () => 'no',
  });
  const catalog = nonInteractiveTools({
    regular,
    suspended,
    resume,
    approval,
    conditional,
    ask_user: regular,
    submit_plan: regular,
    intelligent_ui: regular,
    remote: { ...regular, needsApprovalFn: () => true },
  });
  assert.deepEqual(Object.keys(catalog), ['regular']);
});

test('undeclared suspension is rejected without invoking the runtime suspension', async () => {
  let suspended = false;
  const tool = createTool({
    id: 'undeclared',
    description: 'Undeclared interactive plugin tool',
    inputSchema: z.object({}),
    execute: async (_input, runtime) => runtime.agent!.suspend({}),
  });
  const runtime = execution();
  runtime.agent!.suspend = async () => {
    suspended = true;
  };
  await assert.rejects(
    invoke(guardNonInteractiveTool(tool), {}, runtime),
    /does not support suspended tools/,
  );
  assert.equal(suspended, false);
  assert.equal(
    runtime.requestContext!.get(NON_INTERACTIVE_TOOLS_CONTEXT),
    true,
  );
});

test('frozen Tool instances can be wrapped without changing the source or allowing suspension', async () => {
  const tool = Object.freeze(
    createTool({
      id: 'frozen',
      description: 'Read-only registered tool',
      inputSchema: z.object({ wait: z.boolean() }),
      execute: async ({ wait }, runtime) =>
        wait ? runtime.agent!.suspend({}) : 'ready',
    }),
  );
  const original = tool.execute;
  const wrapped = nonInteractiveTools({ frozen: tool }).frozen;
  assert.equal(await invoke(wrapped, { wait: false }), 'ready');
  await assert.rejects(
    invoke(wrapped, { wait: true }),
    /does not support suspended tools/,
  );
  assert.equal(tool.execute, original);
  assert.equal(Object.getPrototypeOf(wrapped), Object.getPrototypeOf(tool));
  assert.equal(
    Object.getOwnPropertyDescriptor(wrapped, 'execute')?.writable,
    false,
  );
});

test('exec deferred catalog uses the noninteractive policy, normal chats keep interactive tools', async () => {
  const runtime = execution();
  const options = {
    ids: ['ask_user', 'submit_plan', 'intelligent_ui', 'curr_time'],
    includeRuntimeTools: true,
  };
  const regular = await getTools({}, { context: runtime }, options);
  assert.ok(regular.some((tool) => tool.id === 'ask_user'));
  runtime.requestContext!.set(NON_INTERACTIVE_TOOLS_CONTEXT, true);
  const room = await getTools({}, { context: runtime }, options);
  assert.deepEqual(
    room.map((tool) => tool.id),
    ['curr_time'],
  );
});

test('send_ui persists and returns immediately with no suspend or resume schema', async () => {
  const { tools, calls } = fixture();
  assert.equal(tools.send_ui.suspendSchema, undefined);
  assert.equal(tools.send_ui.resumeSchema, undefined);
  const result = await invoke(tools.send_ui, {
    html: '<button data-ui-send="{}">Send</button>',
  });
  assert.deepEqual(result, { messageId: 'message000000001', rendered: true });
  const send = calls.find((call) => call.operation === 'sendAgent')!;
  const payload = send.args[3] as { ui: Record<string, unknown> };
  assert.equal(payload.ui.html, '<button data-ui-send="{}">Send</button>');
  assert.equal('waitForResponse' in payload.ui, false);
});

test('tool calls use the current event actor and a stable publication id', async () => {
  const { tools, calls } = fixture();
  const runtime = execution();
  runtime.requestContext!.set('userId', 'current-project-member');
  await invoke(
    tools.send_message,
    { action: 'send', text: 'First delivery' },
    runtime,
  );
  await invoke(
    tools.send_message,
    { action: 'send', text: 'First delivery' },
    runtime,
  );
  const sends = calls.filter((call) => call.operation === 'sendAgent');
  assert.equal(sends[0].args[0], 'current-project-member');
  assert.equal(calls[0].args[0], 'current-project-member');
  assert.deepEqual(sends[0].args, sends[1].args);
  assert.match((sends[0].args[3] as { id: string }).id, /^[a-f0-9]{32}$/);
});

test('file delivery supplies a caption and room delegation uses a normal visible mention', async () => {
  const { tools, calls } = fixture();
  await invoke(tools.send_message, {
    action: 'file',
    files: [{ path: 'report.pdf', name: 'Report' }],
  });
  const send = calls.find((call) => call.operation === 'sendAgent')!;
  assert.equal((send.args[3] as { text: string }).text, 'Report');
  const info = (await invoke(tools.get_room_info, {})) as {
    agents: { mention: string }[];
  };
  assert.equal(info.agents[0].mention, '@Researcher');
  await invoke(tools.send_message, {
    action: 'send',
    text: '@Researcher Review this report',
  });
  const delegated = calls
    .filter((call) => call.operation === 'sendAgent')
    .at(-1)!.args[3] as Record<string, unknown>;
  assert.equal(delegated.text, '@Researcher Review this report');
  assert.equal('targetAgentId' in delegated, false);
});

test('future plans stay bound to the current member and thread', async () => {
  const { tools, calls } = fixture();
  await invoke(tools.future_plan, {
    text: 'Check the deliverable',
    runAt: '2026-11-01T09:00:00+08:00',
  });
  const plan = calls.find((call) => call.operation === 'createPlan')!;
  assert.deepEqual(plan.args.slice(0, 3), [
    'owner',
    'room000000000001',
    'member0000000001',
  ]);
  assert.match((plan.args[3] as { id: string }).id, /^[a-f0-9]{32}$/);
});

test('room tools return immediately when aborted before or during a service call', async () => {
  const { context, calls } = fixture();
  const before = new AbortController();
  before.abort();
  assert.equal(
    await invoke(
      createGroupChatTools(context).get_room_info,
      {},
      execution(before.signal),
    ),
    '用户中止了操作',
  );
  assert.equal(calls.length, 0);
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  context.service.get = async () => {
    start();
    return new Promise(() => {});
  };
  const during = new AbortController();
  const pending = invoke(
    createGroupChatTools(context).get_room_info,
    {},
    execution(during.signal),
  );
  await started;
  during.abort();
  assert.equal(await pending, '用户中止了操作');
});

test('wrapper preserves configuration, disables native delegation and injects room-only tools', async () => {
  const { context } = fixture();
  context.role = 'worker';
  let captured!: AgentRuntimeOptions;
  const base = createTool({
    id: 'plain',
    description: 'plain',
    execute: async () => 'ok',
  });
  await createGroupChatAgent(
    'configured-agent',
    {
      model: 'test/model',
      instructions: 'Existing configured instructions.',
      buildTools: async () => ({ plain: base, ask_user: base }),
    },
    context,
    async (id, options) => {
      assert.equal(id, 'configured-agent');
      captured = options;
      return {} as Agent;
    },
  );
  assert.equal(captured.allowSubagents, false);
  assert.equal(captured.localSubagents, undefined);
  assert.equal(captured.model, 'test/model');
  assert.match(
    captured.instructions as string,
    /Existing configured instructions/,
  );
  assert.match(captured.instructions as string, /only|Only/);
  assert.match(
    captured.instructions as string,
    /\/share\/\.agents\/room\/MEMORY.md/,
  );
  const catalog = await captured.buildTools!();
  assert.ok(
    catalog.plain &&
      catalog.send_message &&
      catalog.send_ui &&
      catalog.future_plan,
  );
  assert.equal(catalog.ask_user, undefined);
});

test('room tools are hidden from normal and deferred catalogs, even when requested explicitly', async () => {
  const { context } = fixture();
  const definition = new BotAgentTools(context);
  assert.equal(definition.hidden, true);
  assert.deepEqual(
    (await definition.getTools()).map((tool) => tool.id).sort(),
    [...definition.ids].sort(),
  );
  assert.deepEqual(await new BotAgentTools().getTools(), []);
  const ordinary = await getTools();
  const deferred = await getTools(
    {},
    { context: execution() },
    { includeRuntimeTools: true },
  );
  for (const id of definition.ids) {
    assert.equal(registeredToolIds.includes(id), false);
    assert.equal(
      ordinary.some((tool) => tool.id === id),
      false,
    );
    assert.equal(
      deferred.some((tool) => tool.id === id),
      false,
    );
    assert.throws(() => parseToolConfig(id, {}), /Unknown tool ID/);
    await assert.rejects(getTools({}, {}, { ids: [id] }), /Unknown tool ID/);
  }
});

test('the leader uses its own code agent without resolving a selected generic agent', async () => {
  const { context } = fixture();
  const agent = await createGroupChatAgent(
    'old-generic-agent',
    {
      model: 'test/model',
      buildTools: async () => ({}),
      localSubagents: async () =>
        assert.fail('Room leaders must not discover native subagents'),
    },
    context,
    async () => assert.fail('The leader must not load a generic agent'),
  );
  assert.equal(agent.id, botAgent.id);
  assert.deepEqual(await agent.listAgents(), {});
  assert.match(String(await agent.getInstructions()), /dedicated leader/);
  assert.match(String(await agent.getInstructions()), /room000000000001/);
});
