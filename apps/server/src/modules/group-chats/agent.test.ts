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
  createRoomManagementTool,
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
        role: 'bot',
        threadId: 'thread0000000001',
        settings: {
          agentId: 'code:code',
          model: 'test/model',
          reasoningEffort: 'high',
        },
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
      addAgent: record('addAgent', { id: 'worker0000000002' }),
      updateAgent: record('updateAgent', { id: 'worker0000000001' }),
      removeAgent: record('removeAgent', undefined),
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

test('send_message returns a plain-text success receipt for every successful action', async () => {
  const { tools, message } = fixture();
  for (const input of [
    { action: 'send', text: 'Hello' },
    { action: 'reply', text: 'Reply', messageId: message.id },
    { action: 'file', files: [{ path: 'report.pdf', name: 'Report' }] },
    { action: 'send', text: '@Researcher Review this report' },
  ]) {
    assert.equal(
      await invoke(tools.send_message, input),
      `Send message success Id: ${message.id}`,
    );
  }
  assert.ok(
    (
      await tools.send_message.inputSchema!['~standard'].validate({
        action: 'reaction',
        messageId: message.id,
        emoji: '👍',
      })
    ).issues,
  );
});

test('send_message publishes single and multiple choices without suspending', async () => {
  const { tools, calls, message } = fixture();
  assert.equal(tools.send_message.suspendSchema, undefined);
  assert.equal(tools.send_message.resumeSchema, undefined);
  for (const multiple of [false, true]) {
    const choices = { options: ['修复问题', '补充测试'], multiple };
    const result = await invoke(tools.send_message, {
      action: 'send',
      text: '先处理哪一项？',
      choices,
    });
    assert.equal(result, `Send message success Id: ${message.id}`);
    assert.deepEqual(calls.at(-1)?.args[3], {
      id: (calls.at(-1)?.args[3] as { id: string }).id,
      toolCallId: 'native-call-1',
      text: '先处理哪一项？',
      choices,
    });
  }
  const schema = tools.send_message.inputSchema!['~standard'];
  const single = await schema.validate({
    text: '选择一个',
    choices: { options: ['甲', '乙'] },
  });
  assert.equal(single.issues, undefined);
  if (!single.issues) assert.equal(single.value.choices?.multiple, false);
  for (const options of [[], [''], ['甲', '甲']]) {
    assert.ok(
      (await schema.validate({ text: '选择一个', choices: { options } }))
        .issues,
    );
  }
  await assert.rejects(
    () =>
      invoke(tools.send_message, {
        action: 'send',
        choices: { options: ['甲'] },
      }),
    /question in text/,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  const callCount = calls.length;
  assert.equal(
    await invoke(
      tools.send_message,
      {
        action: 'send',
        text: '选择一个',
        choices: { options: ['甲'] },
      },
      execution(cancelled.signal),
    ),
    '用户中止了操作',
  );
  assert.equal(calls.length, callCount);
});

test('reaction batches messages and emojis in order using the current actor and room member', async () => {
  const { tools, calls, context } = fixture();
  const runtime = execution();
  runtime.requestContext!.set('userId', 'current-project-member');
  const result = await invoke(
    tools.reaction,
    {
      reactions: [
        { messageId: 'first-message', emoji: '👀' },
        { messageId: 'second-message', emoji: '⭐', active: true },
        { messageId: 'first-message', emoji: '👀', active: false },
        { messageId: 'first-message', emoji: '✅' },
      ],
    },
    runtime,
  );
  assert.deepEqual(
    calls.filter((call) => call.operation === 'react').map((call) => call.args),
    [
      ['first-message', { emoji: '👀', active: true }],
      ['second-message', { emoji: '⭐', active: true }],
      ['first-message', { emoji: '👀', active: false }],
      ['first-message', { emoji: '✅', active: true }],
    ].map(([id, input]) => [
      'current-project-member',
      context.roomId,
      id,
      input,
      context.memberId,
    ]),
  );
  assert.equal(
    calls.some((call) => call.operation === 'sendAgent'),
    false,
  );
  assert.equal(
    result,
    'OK first-message: added 👀\nOK second-message: added ⭐\nOK first-message: removed 👀\nOK first-message: added ✅',
  );
  assert.equal(tools.reaction.suspendSchema, undefined);
  assert.equal(tools.reaction.resumeSchema, undefined);
  assert.match(String(botAgent.instructions), /reaction tool/);
  assert.doesNotMatch(String(botAgent.instructions), /action="reaction"/);
});

test('reaction reports individual failures and continues the batch', async () => {
  const { context, message } = fixture();
  const processed: string[] = [];
  context.service.react = async (_userId, _roomId, id) => {
    processed.push(id);
    if (id === 'unavailable') throw new Error('Message not found');
    return { ...message, id };
  };
  const result = await invoke(createGroupChatTools(context).reaction, {
    reactions: [
      { messageId: 'first', emoji: '👀' },
      { messageId: 'unavailable', emoji: '⭐' },
      { messageId: 'last', emoji: '✅' },
    ],
  });
  assert.deepEqual(processed, ['first', 'unavailable', 'last']);
  assert.equal(
    result,
    'OK first: added 👀\nERROR unavailable (⭐): Message not found\nOK last: added ✅',
  );
});

test('reaction rejects empty batches and disabled room agents without mutations', async () => {
  const { context, calls, tools } = fixture();
  await assert.rejects(
    invoke(tools.reaction, { reactions: [] }),
    /at least one/,
  );
  const getAgent = context.service.getAgent;
  context.service.getAgent = async (...args) => ({
    ...(await getAgent(...args)),
    enabled: false,
  });
  await assert.rejects(
    invoke(createGroupChatTools(context).reaction, {
      reactions: [{ messageId: 'first', emoji: '👀' }],
    }),
    /no longer active/,
  );
  assert.equal(
    calls.some((call) => call.operation === 'react'),
    false,
  );
});

test('reaction returns immediately on abort and never starts the remaining entries', async () => {
  const { context, calls, message } = fixture();
  const input = {
    reactions: [
      { messageId: 'first', emoji: '👀' },
      { messageId: 'second', emoji: '⭐' },
    ],
  };
  const before = new AbortController();
  before.abort();
  assert.equal(
    await invoke(
      createGroupChatTools(context).reaction,
      input,
      execution(before.signal),
    ),
    '用户中止了操作',
  );
  assert.equal(calls.length, 0);
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const pendingWrite = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const processed: string[] = [];
  context.service.react = async (_userId, _roomId, id) => {
    processed.push(id);
    start();
    await pendingWrite;
    return { ...message, id };
  };
  const during = new AbortController();
  const pending = invoke(
    createGroupChatTools(context).reaction,
    input,
    execution(during.signal),
  );
  await started;
  during.abort();
  assert.equal(await pending, '用户中止了操作');
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, ['first']);
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
  assert.equal(
    (sends[0].args[3] as { toolCallId: string }).toolCallId,
    runtime.agent!.toolCallId,
  );
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
      catalog.reaction &&
      catalog.send_ui &&
      catalog.future_plan,
  );
  assert.equal(catalog.ask_user, undefined);
  assert.equal(catalog.room_management, undefined);
});

test('room management mounts only for the leader and rejects stale or worker bindings', async () => {
  const { context } = fixture();
  assert.ok(
    (await new BotAgentTools(context).getTools()).some(
      (tool) => tool.id === 'room_management',
    ),
  );
  context.role = 'worker';
  assert.equal(
    (await new BotAgentTools(context).getTools()).some(
      (tool) => tool.id === 'room_management',
    ),
    false,
  );
  await assert.rejects(
    invoke(createRoomManagementTool(context), {
      action: 'remove_agent',
      args: { memberId: 'worker' },
    }),
    /only available to the room bot/,
  );
  context.role = 'bot';
  const member = await context.service.getAgent(
    context.userId,
    context.roomId,
    context.memberId,
  );
  context.service.getAgent = async () => ({ ...member, role: 'worker' });
  await assert.rejects(
    invoke(createRoomManagementTool(context), {
      action: 'list_agents',
      args: {},
    }),
    /only available to the room bot/,
  );
  context.service.getAgent = async () => ({
    ...member,
    threadId: 'old-thread',
  });
  await assert.rejects(
    invoke(createRoomManagementTool(context), {
      action: 'list_agents',
      args: {},
    }),
    /no longer active/,
  );
});

test('room management uses only action and args and binds catalog access to the executing user', async () => {
  const { context, calls } = fixture();
  const available = [
    {
      id: 'code:code',
      name: 'Code',
      description: 'Coding',
      model: null,
      source: 'code' as const,
    },
  ];
  context.availableAgents = async (userId) => {
    assert.equal(userId, 'admin');
    return {
      agents: available,
      defaultAgentId: 'code:code',
    };
  };
  const tool = createRoomManagementTool(context);
  assert.ok(tool.inputSchema instanceof z.ZodObject);
  assert.deepEqual(Object.keys(tool.inputSchema.shape), ['action', 'args']);
  const runtime = execution();
  runtime.requestContext!.set('userId', 'admin');
  const result = (await invoke(
    tool,
    {
      action: 'list_agents',
      args: { userId: 'owner', roomId: 'another-room' },
    },
    runtime,
  )) as { availableAgents: unknown; members: unknown };
  assert.deepEqual(result.availableAgents, available);
  assert.deepEqual(result.members, [
    { id: 'worker0000000001', name: 'Researcher' },
  ]);
  assert.deepEqual(calls.find((call) => call.operation === 'get')?.args, [
    'admin',
    context.roomId,
  ]);
});

test('room management creates, patches and removes members without accepting caller-supplied room or actor', async () => {
  const { context, calls } = fixture();
  const tool = createRoomManagementTool(context);
  const runtime = execution();
  runtime.requestContext!.set('userId', 'admin');
  await invoke(
    tool,
    {
      action: 'add_agent',
      args: {
        name: 'Researcher',
        settings: { agentId: 'code:code' },
        roomId: 'another-room',
        userId: 'owner',
        role: 'bot',
      },
    },
    runtime,
  );
  assert.deepEqual(calls.at(-1), {
    operation: 'addAgent',
    args: [
      'admin',
      context.roomId,
      {
        name: 'Researcher',
        settings: {
          agentId: 'code:code',
          model: null,
          reasoningEffort: 'auto',
        },
      },
    ],
  });
  await invoke(
    tool,
    {
      action: 'update_agent',
      args: {
        memberId: 'worker0000000001',
        settings: { reasoningEffort: 'low' },
        enabled: false,
      },
    },
    runtime,
  );
  assert.deepEqual(calls.at(-1), {
    operation: 'updateAgent',
    args: [
      'admin',
      context.roomId,
      'worker0000000001',
      {
        settings: {
          agentId: 'code:code',
          model: 'test/model',
          reasoningEffort: 'low',
        },
        enabled: false,
      },
    ],
  });
  await invoke(
    tool,
    {
      action: 'update_agent',
      args: { memberId: 'worker0000000001', settings: { model: null } },
    },
    runtime,
  );
  assert.deepEqual((calls.at(-1)?.args[3] as { settings: unknown }).settings, {
    agentId: 'code:code',
    model: null,
    reasoningEffort: 'high',
  });
  assert.deepEqual(
    await invoke(
      tool,
      { action: 'remove_agent', args: { memberId: 'worker0000000001' } },
      runtime,
    ),
    { memberId: 'worker0000000001', removed: true },
  );
  assert.deepEqual(calls.at(-1), {
    operation: 'removeAgent',
    args: ['admin', context.roomId, 'worker0000000001'],
  });
  await assert.rejects(
    invoke(tool, {
      action: 'update_agent',
      args: { memberId: 'worker0000000001' },
    }),
    /at least one Agent field/,
  );
  context.service.removeAgent = async () => {
    throw new Error('FORBIDDEN');
  };
  await assert.rejects(
    invoke(tool, {
      action: 'remove_agent',
      args: { memberId: 'worker0000000001' },
    }),
    /FORBIDDEN/,
  );
});

test('room management aborts immediately and never starts a mutation after a cancelled read', async () => {
  const { context, calls } = fixture();
  const before = new AbortController();
  before.abort();
  assert.equal(
    await invoke(
      createRoomManagementTool(context),
      { action: 'remove_agent', args: { memberId: 'worker' } },
      execution(before.signal),
    ),
    '用户中止了操作',
  );
  assert.equal(calls.length, 0);
  let release!: (
    value: Awaited<ReturnType<typeof context.service.getAgent>>,
  ) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = context.service.getAgent;
  context.service.getAgent = async (...args) => {
    if (args[2] !== 'worker') return original(...args);
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const during = new AbortController();
  const pending = invoke(
    createRoomManagementTool(context),
    { action: 'update_agent', args: { memberId: 'worker', name: 'New name' } },
    execution(during.signal),
  );
  await ready;
  during.abort();
  assert.equal(await pending, '用户中止了操作');
  release(await original('owner', context.roomId, 'worker'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    calls.some((call) => call.operation === 'updateAgent'),
    false,
  );
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
