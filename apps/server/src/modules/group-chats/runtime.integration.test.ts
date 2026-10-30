import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import type {
  GroupChatAgent,
  GroupChatMessage,
  GroupChatMessages,
} from '@aime/shared/group-chats';
import { botAgent } from '../../mastra/agents/bot-agent.js';
import { createChatRunner } from '../threads/runner.js';
import { ThreadService } from '../threads/service.js';
import { createPersonalSharedDirectory } from '../threads/workspace.js';
import type { LanguageModelService } from '../models/language-model.js';
import type { GroupChatService, AgentRoomMessageInput } from './service.js';

const settings = {
  agentId: 'code:assistant',
  model: 'mock/room',
  reasoningEffort: 'auto',
} as const;
const member: GroupChatAgent = {
  id: 'roomagent0000001',
  roomId: 'room000000000001',
  threadId: 'roomthread000001',
  name: 'Bot',
  role: 'bot',
  settings,
  enabled: true,
  status: 'idle',
  error: null,
  lastReadSequence: '0',
  idleWakeHours: null,
};
function toolReply(name: string, input: unknown, call: number) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: `tool-${call}`,
          toolName: name,
          input: JSON.stringify(input),
        });
        controller.enqueue({
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        controller.close();
      },
    }),
  };
}
function textReply(text: string) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text' });
        controller.enqueue({ type: 'text-delta', id: 'text', delta: text });
        controller.enqueue({ type: 'text-end', id: 'text' });
        controller.enqueue({
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        controller.close();
      },
    }),
  };
}
async function settled(threads: ThreadService) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await threads.getThread('alice', member.threadId);
    if (state.thread.status === 'failed')
      assert.fail(`Room run failed: ${state.thread.error}`);
    if (state.thread.status === 'success') return state;
    assert.notEqual(state.thread.status, 'suspended');
    await delay(10);
  }
  assert.fail('Room native execution did not settle within 10 seconds');
}

test('native room agent publishes only tools, refreshes MEMORY.md and continues the same private thread without suspension', async (t) => {
  const root = await mkdtemp('/tmp/group-chat-native-');
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({
    storage,
    logger: false,
    backgroundTasks: { enabled: true },
  });
  const publications: GroupChatMessage[] = [];
  const recentReads: string[] = [];
  const prompts: string[] = [];
  const catalogs: string[][] = [];
  let event = 1;
  const page: GroupChatMessages = {
    messages: [],
    hasMore: false,
    revision: '0',
  };
  const rooms = {
    getAgent: async (userId: string, roomId: string, memberId: string) => {
      assert.equal(userId, 'alice');
      assert.equal(roomId, member.roomId);
      assert.equal(memberId, member.id);
      return member;
    },
    recentMessages: async (userId: string) => {
      recentReads.push(userId);
      return {
        ...page,
        messages: [
          {
            id: `human-event-${event}`,
            roomId: member.roomId,
            senderId: 'alice',
            senderKind: 'user',
            senderName: 'Alice Example',
            senderUsername: 'alice_handle',
            text: `Human message ${event}`,
          } as GroupChatMessage,
        ],
      };
    },
    sendAgent: async (
      userId: string,
      roomId: string,
      memberId: string,
      input: AgentRoomMessageInput,
    ) => {
      assert.equal(userId, 'alice');
      assert.equal(roomId, member.roomId);
      assert.equal(memberId, member.id);
      const message: GroupChatMessage = {
        ...input,
        roomId,
        senderId: memberId,
        senderKind: 'agent',
        senderName: member.name,
        senderUsername: null,
        sequence: String(publications.length + 1),
        revision: String(publications.length + 1),
        replyToId: input.replyToId ?? null,
        files: input.files ?? [],
        ui: input.ui ?? null,
        uiResponse: null,
        targetAgentId: input.targetAgentId ?? null,
        reactions: [],
        createdAt: new Date().toISOString(),
      };
      publications.push(message);
      return message;
    },
  } as unknown as GroupChatService;
  const model = new MastraLanguageModelV2Mock({
    doStream: async ({ prompt, tools }) => {
      const call = prompts.push(JSON.stringify(prompt));
      catalogs.push(
        (tools ?? []).flatMap((tool) => ('name' in tool ? [tool.name] : [])),
      );
      if (call === 1 || call === 5)
        return toolReply('get_room_recent_messages', {}, call);
      assert.ok(JSON.stringify(prompt).includes('Alice Example'));
      assert.ok(JSON.stringify(prompt).includes('alice_handle'));
      if (call === 2 || call === 6)
        return toolReply(
          'send_message',
          { action: 'send', text: `Visible room delivery ${event}` },
          call,
        );
      if (call === 3)
        return toolReply(
          'send_ui',
          {
            title: 'Task choices',
            html: '<button data-ui-send=\'{"choice":"research"}\'>Research</button>',
          },
          call,
        );
      assert.ok(
        call === 4 || call === 7,
        `Unexpected model loop at step ${call}`,
      );
      return textReply(`Private final summary ${event}`);
    },
  });
  const interactive = (id: string) =>
    createTool({
      id,
      description: 'Must not be exposed in rooms',
      inputSchema: z.object({}),
      suspendSchema: z.object({ question: z.string() }),
      resumeSchema: z.string(),
      execute: async () => {
        assert.fail('Interactive tool executed');
      },
    });
  const runner = createChatRunner(
    mastra,
    {
      getLanguageModel: async (
        _userId: string,
        selected: { model?: string | null },
      ) => {
        assert.equal(
          selected.model,
          'mock/room',
          'Room model overrides the configured agent model',
        );
        return {
          model,
          reference: 'mock/room',
          maxOutputTokens: 1000,
          providerOptions: {},
          supportsImages: false,
          toolCall: true,
        };
      },
    } as unknown as LanguageModelService,
    root,
    undefined,
    {
      buildTools: async () => ({
        ask_user: interactive('ask_user'),
        intelligent_ui: interactive('intelligent_ui'),
        custom_suspend: interactive('custom_suspend'),
      }),
    },
    {
      getConfig: async () =>
        assert.fail('Room leader must not resolve ordinary agent defaults'),
      getAgent: async () =>
        assert.fail('Room leader must construct its own hidden agent'),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    rooms,
  );
  const threads = new ThreadService(
    memory,
    runner,
    undefined,
    mastra.backgroundTaskManager,
  );
  t.after(async () => {
    await threads.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await threads.ensureGroupChatThread({
    ...member,
    memberId: member.id,
    userId: 'alice',
    title: 'Room bot',
  });
  const first = await memory.getThreadById({ threadId: member.threadId });
  assert.ok(first);
  const shared = await createPersonalSharedDirectory(root, 'alice');
  assert.equal(first.metadata?.workspace, shared);
  assert.equal((await threads.listThreads('alice')).threads.length, 0);
  const memoryDirectory = join(
    shared,
    '.agents',
    'group-chats',
    member.roomId,
    member.id,
  );
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(
    join(memoryDirectory, 'MEMORY.md'),
    'Durable room fact: cobalt-bridge-731',
  );
  const run = () =>
    threads.runGroupChat('alice', member.threadId, {
      ...settings,
      id: `room-event-0000${event}`,
      isImmediate: false,
      parts: [
        { type: 'text', text: `Room event ${event}. Read recent messages.` },
      ],
    });
  await run();
  const completed = await settled(threads);
  assert.equal(completed.toolInteractions?.length ?? 0, 0);
  assert.deepEqual(recentReads, ['alice']);
  assert.equal(publications.length, 2);
  assert.equal(publications[0].text, 'Visible room delivery 1');
  assert.equal(publications[1].ui?.title, 'Task choices');
  assert.equal(
    publications.some((message) => message.text.includes('Private final')),
    false,
  );
  assert.match(prompts[0], /cobalt-bridge-731/);
  for (const names of catalogs) {
    assert.ok(names.includes('send_message'));
    assert.ok(names.includes('send_ui'));
    assert.ok(names.includes('get_room_recent_messages'));
    assert.ok(
      !names.some(
        (name) =>
          ['ask_user', 'intelligent_ui', 'custom_suspend'].includes(name) ||
          name.startsWith('agent-'),
      ),
    );
  }
  event = 2;
  await writeFile(
    join(memoryDirectory, 'MEMORY.md'),
    'Updated durable room fact: amber-garden-842',
  );
  await run();
  await settled(threads);
  assert.equal(prompts.length, 7);
  assert.deepEqual(recentReads, ['alice', 'alice']);
  assert.equal(publications.length, 3);
  assert.equal(publications[2].text, 'Visible room delivery 2');
  assert.match(prompts[4], /amber-garden-842/);
  assert.match(prompts[4], /Private final summary 1/);
  const stored = await memory.getThreadById({ threadId: member.threadId });
  assert.equal(stored?.id, first.id);
  assert.equal(stored?.metadata?.agentId, botAgent.id);
  assert.equal(stored?.metadata?.workspace, shared);
  const history = await threads.history('alice', member.threadId);
  assert.ok(
    history.messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === 'text' && part.text.includes('Private final summary 2'),
      ),
    ),
  );
  await threads.ensureGroupChatThread({
    ...member,
    memberId: 'roomworker000001',
    threadId: 'workerthread0001',
    role: 'worker',
    userId: 'alice',
    title: 'Worker',
  });
  assert.equal(
    (await memory.getThreadById({ threadId: 'workerthread0001' }))?.metadata
      ?.workspace,
    shared,
  );
});
