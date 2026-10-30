import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  GroupChatAgent,
  GroupChatDetail,
  GroupChatEvent,
} from '@aime/shared/group-chats';
import type { RunInput } from '@aime/shared/threads';
import type { GroupChatLifecycle } from '../apps/server/src/modules/group-chats/service.js';
import {
  createGroupChatRuntime,
  roomEventInputId,
} from '../apps/server/src/modules/group-chats/runtime.js';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import type { ChatSessionContext } from '../apps/server/src/modules/threads/session.js';
import { sessionStub } from './fixtures/thread-session.js';

const settings = {
  model: null,
  agentId: null,
  reasoningEffort: 'auto' as const,
};
const member: GroupChatAgent = {
  id: 'room-member-00001',
  roomId: 'room-00000000001',
  threadId: 'thread-000000001',
  name: 'Bot',
  role: 'bot',
  settings,
  enabled: true,
  status: 'idle',
  error: null,
  lastReadSequence: '0',
  idleWakeHours: null,
};
const room: GroupChatDetail = {
  id: member.roomId,
  title: 'Room',
  projectId: null,
  createdBy: 'alice',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  memberIds: ['alice'],
  canManage: true,
  agents: [member],
  botAgentId: member.id,
};
function event(patch: Partial<GroupChatEvent> = {}): GroupChatEvent {
  return {
    id: 'event-0000000001',
    version: 'version-00000001',
    roomId: room.id,
    agentId: member.id,
    actorId: 'alice',
    kind: 'messages',
    text: '',
    dueAt: new Date().toISOString(),
    status: 'pending',
    error: null,
    ...patch,
  };
}
function fixture(events = [event()], activeUser = true) {
  const runs: { userId: string; threadId: string; input: RunInput }[] = [];
  const claims: string[] = [];
  const acks: string[] = [];
  const defers: { id: string; error?: string; delay?: number }[] = [];
  const statuses: string[] = [];
  const statusErrors: (string | null | undefined)[] = [];
  const disposals: { roomId: string; threadId: string; remove: boolean }[] = [];
  let lifecycle!: GroupChatLifecycle;
  let status = 'idle';
  let claim = true;
  let failure: unknown;
  const runtime = createGroupChatRuntime(
    {
      setLifecycle(value) {
        lifecycle = value;
      },
      async setAgentStatus(_id, value, error) {
        statuses.push(value);
        statusErrors.push(error);
      },
      async get() {
        return room;
      },
      async getAgent() {
        return {
          ...member,
          idleWakeHours: events.some((item) => item.kind === 'idle')
            ? 2
            : member.idleWakeHours,
        };
      },
      async scheduleIdleEvents() {},
      async dueEvents() {
        return events;
      },
      async claimEvent(id) {
        claims.push(id);
        return claim;
      },
      async acknowledgeEvent(id) {
        acks.push(id);
      },
      async deferEvent(id, _version, error, delay) {
        defers.push({ id, error, delay });
      },
    },
    {
      async ensureGroupChatThread() {},
      async disposeGroupChatThread(roomId, threadId, remove = false) {
        disposals.push({ roomId, threadId, remove });
      },
      async validateGroupChatSettings() {},
      async getThread() {
        return { thread: { status, queueCount: 0 } } as Awaited<
          ReturnType<ThreadService['getThread']>
        >;
      },
      async runGroupChat(userId, threadId, input) {
        if (failure !== undefined) throw failure;
        runs.push({ userId, threadId, input });
        return {} as Awaited<ReturnType<ThreadService['runGroupChat']>>;
      },
      setGroupChatObserver() {},
      async resolveWorkspaceFile() {
        return { path: 'report.pdf', scope: 'thread', kind: 'file' };
      },
    },
    async () => activeUser,
  );
  return {
    runtime,
    runs,
    claims,
    acks,
    defers,
    statuses,
    statusErrors,
    disposals,
    get lifecycle() {
      return lifecycle;
    },
    setStatus(value: string) {
      status = value;
    },
    loseClaim() {
      claim = false;
    },
    failRun(
      error: unknown = Object.assign(new Error('Unavailable'), {
        code: 'MODEL_UNAVAILABLE',
      }),
    ) {
      failure = error;
    },
  };
}

test('message events and future plans wake the same bound thread; final content is never published', async () => {
  const f = fixture();
  await f.runtime.tick();
  assert.equal(f.runs[0].threadId, member.threadId);
  assert.match(
    f.runs[0].input.parts[0].type === 'text'
      ? f.runs[0].input.parts[0].text
      : '',
    /get_room_recent_messages/,
  );
  assert.deepEqual(f.acks, ['event-0000000001']);
  const plan = fixture([
    event({ kind: 'plan', text: 'Check the build result' }),
  ]);
  await plan.runtime.tick();
  assert.equal(plan.runs[0].threadId, member.threadId);
  assert.match(
    JSON.stringify(plan.runs[0].input.parts),
    /Check the build result/,
  );
  assert.equal(plan.runs[0].input.id, f.runs[0].input.id);
  assert.notEqual(
    roomEventInputId('event', 'v1'),
    roomEventInputId('event', 'v2'),
  );
  await f.runtime.shutdown();
  await plan.runtime.shutdown();
});

test('busy thread keeps its event pending and a refreshed debounce claim prevents early dispatch', async () => {
  const f = fixture();
  f.setStatus('running');
  await f.runtime.tick();
  assert.equal(f.runs.length, 0);
  assert.equal(f.claims.length, 0);
  assert.equal(f.defers[0].delay, 5000);
  f.setStatus('idle');
  f.loseClaim();
  await f.runtime.tick();
  assert.equal(f.runs.length, 0);
  assert.equal(f.acks.length, 0);
  await f.runtime.shutdown();
});

test('idle events proactively inspect useful work in the original thread without affecting normal configuration', async () => {
  const f = fixture([event({ kind: 'idle' })]);
  await f.runtime.tick();
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].threadId, member.threadId);
  assert.match(JSON.stringify(f.runs[0].input.parts), /Look for useful work/);
  assert.match(JSON.stringify(f.runs[0].input.parts), /finish quietly/);
  await f.lifecycle.updateAgent!(room, member, { ...member, idleWakeHours: 2 });
  assert.equal(
    f.disposals.length,
    0,
    'Changing an idle setting must not stop the current thread',
  );
  await f.runtime.shutdown();
});

test('mention events insert the addressed message into the existing thread once it is free', async () => {
  const f = fixture([
    event({
      kind: 'task',
      text: 'Room message message-1 from user Alice (alice):\n@Researcher 请分析',
    }),
  ]);
  f.setStatus('running');
  await f.runtime.tick();
  assert.equal(f.runs.length, 0);
  assert.equal(f.acks.length, 0);
  f.setStatus('idle');
  await f.runtime.tick();
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].threadId, member.threadId);
  assert.match(
    JSON.stringify(f.runs[0].input.parts),
    /message-1 from user Alice/,
  );
  assert.match(JSON.stringify(f.runs[0].input.parts), /@Researcher 请分析/);
  assert.equal(f.runs[0].input.isImmediate, false);
  assert.equal(f.acks.length, 1);
  await f.runtime.shutdown();
});

test('same agent cannot dispatch two events in one tick; failed submissions remain retryable', async () => {
  const f = fixture([event(), event({ id: 'second' })]);
  await Promise.all([f.runtime.tick(), f.runtime.tick()]);
  assert.equal(f.runs.length, 1);
  const failure = fixture();
  failure.failRun();
  await failure.runtime.tick();
  assert.deepEqual(failure.statuses, ['failed']);
  assert.equal(failure.defers[0].error, 'MODEL_UNAVAILABLE');
  assert.equal(failure.acks.length, 0);
  await f.runtime.shutdown();
  await failure.runtime.shutdown();
  await failure.runtime.tick();
  assert.equal(failure.defers.length, 1);
});

test('submission diagnostics retain plain error messages without logging provider payloads', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const message = 'Tool catalog could not be loaded';
  const cases = [
    {
      error: Object.assign(new Error(message), {
        request: { headers: { Authorization: 'secret-provider-token' } },
      }),
      expected: message,
    },
    {
      error: new Error(
        JSON.stringify({
          message,
          request: { apiKey: 'secret-provider-token' },
        }),
      ),
      expected: message,
    },
    { error: {}, expected: 'ROOM_AGENT_RUN_FAILED' },
  ];
  for (const { error, expected } of cases) {
    const f = fixture();
    f.failRun(error);
    await f.runtime.tick();
    assert.deepEqual(f.statusErrors, [expected]);
    assert.equal(f.defers[0].error, expected);
    assert.equal(f.acks.length, 0);
    const entry = log.mock.calls.at(-1)!.arguments;
    assert.equal(entry[0], 'Group chat event dispatch failed');
    assert.deepEqual(entry[1], {
      eventId: 'event-0000000001',
      roomId: room.id,
      agentId: member.id,
      phase: 'submit',
      code: 'ROOM_AGENT_RUN_FAILED',
      message: expected === 'ROOM_AGENT_RUN_FAILED' ? 'CHAT_FAILED' : message,
    });
    assert.ok(!JSON.stringify(entry).includes('secret-provider-token'));
    await f.runtime.shutdown();
  }
});

test('disabling or reconfiguring a member closes its session; deleting removes only the dedicated thread', async () => {
  const f = fixture();
  await f.lifecycle.updateAgent!(room, member, { ...member, enabled: false });
  await f.lifecycle.updateAgent!(room, member, {
    ...member,
    settings: { ...settings, model: 'provider/model' },
  });
  await f.lifecycle.removeAgents!(room, [member]);
  assert.deepEqual(
    f.disposals.map((value) => value.remove),
    [false, false, true],
  );
  assert.ok(f.disposals.every((value) => value.threadId === member.threadId));
  await f.runtime.shutdown();
});

test('dedicated threads are provisioned once, use shared storage and reject ordinary chat lifecycle entry points', async () => {
  const { memory, threads: stored } = fakeMemory();
  let opened = 0;
  let allowed = true;
  const statuses: string[] = [];
  const runner: ChatRunner = {
    async validate() {},
    async assertGroupChatRun() {
      if (!allowed) throw new Error('ROOM_AGENT_DISABLED');
    },
    async createWorkspace() {
      return '/workspace/project';
    },
    async personalSharedDirectory() {
      return '/workspace/shared';
    },
    async open() {
      opened++;
      return sessionStub();
    },
  };
  const service = new ThreadService(memory, runner);
  service.setGroupChatObserver(async (_binding, status) => {
    statuses.push(status);
  });
  const binding = {
    roomId: room.id,
    memberId: member.id,
    role: 'bot' as const,
    threadId: member.threadId,
    userId: 'alice',
    title: 'Room Bot',
    settings,
  };
  await Promise.all([
    service.ensureGroupChatThread(binding),
    service.ensureGroupChatThread(binding),
  ]);
  assert.equal(stored.size, 1);
  assert.equal(
    stored.get(member.threadId)!.metadata!.workspace,
    '/workspace/shared',
  );
  assert.equal((await service.listThreads('alice')).threads.length, 0);
  const input: RunInput = {
    ...settings,
    id: 'event-input-id',
    parts: [{ type: 'text', text: 'A room event' }],
    isImmediate: false,
  };
  await assert.rejects(
    service.run('alice', member.threadId, input),
    /FORBIDDEN/,
  );
  await assert.rejects(
    service.updateThread('alice', member.threadId, {
      title: 'Ordinary rename',
    }),
    /FORBIDDEN/,
  );
  await service.runGroupChat('alice', member.threadId, input);
  await service.runGroupChat('alice', member.threadId, input);
  assert.equal(opened, 1);
  assert.ok(statuses.includes('pending'));
  await assert.rejects(service.retry('alice', member.threadId), /FORBIDDEN/);
  await assert.rejects(
    service.continueRun('alice', member.threadId),
    /FORBIDDEN/,
  );
  await assert.rejects(service.abort('alice', member.threadId), /FORBIDDEN/);
  await assert.rejects(
    service.respondToTool('alice', member.threadId, 'old-interaction', {
      id: 'response-id',
      action: 'resume',
      data: {},
    }),
    /FORBIDDEN/,
  );
  allowed = false;
  await assert.rejects(
    service.runGroupChat('alice', member.threadId, {
      ...input,
      id: 'next-room-event',
    }),
    /ROOM_AGENT_DISABLED/,
  );
  assert.equal(opened, 1);
  await service.disposeGroupChatThread(room.id, member.threadId, true);
  assert.equal(stored.size, 0);
  await service.shutdown();
});

test('scheduled events from banned or deleted users never start a thread', async () => {
  const f = fixture([event({ kind: 'plan', text: 'Later work' })], false);
  await f.runtime.tick();
  assert.equal(f.claims.length, 0);
  assert.equal(f.runs.length, 0);
  assert.equal(f.defers[0].error, 'FORBIDDEN');
  await f.runtime.shutdown();
});

test('invited room members share the owner workspace but never ordinary threads', async () => {
  const { memory, threads: stored } = fakeMemory();
  const members = new Set(['alice']);
  const service = new ThreadService(memory, {
    async validate() {},
    async assertGroupChatAccess(userId) {
      if (!members.has(userId)) throw new Error('THREAD_NOT_FOUND');
    },
    async createWorkspace() {
      return '/workspace/project';
    },
    async personalSharedDirectory(userId) {
      return `/workspace/${userId}/shared`;
    },
    async open() {
      return sessionStub();
    },
  });
  await service.ensureGroupChatThread({
    roomId: room.id,
    memberId: member.id,
    role: 'bot',
    threadId: member.threadId,
    userId: 'alice',
    title: 'Shared room',
    settings,
  });
  await assert.rejects(
    service.getThread('bob', member.threadId),
    /THREAD_NOT_FOUND/,
  );
  members.add('bob');
  assert.equal(
    (await service.getThread('bob', member.threadId)).thread.id,
    member.threadId,
  );
  assert.equal(
    await service.withWorkspaceFiles(
      'bob',
      member.threadId,
      async (root) => root,
      'shared',
    ),
    '/workspace/alice/shared',
  );
  assert.equal(
    await service.workspaceDirectory('bob', member.threadId),
    '/workspace/alice/shared',
  );
  await service.runGroupChat('bob', member.threadId, {
    ...settings,
    id: 'invited-event',
    isImmediate: false,
    parts: [{ type: 'text', text: 'A room event' }],
  });
  const ordinary = structuredClone(stored.get(member.threadId)!);
  ordinary.id = 'ordinary00000001';
  delete ordinary.metadata!.groupChat;
  stored.set(ordinary.id, ordinary);
  await assert.rejects(
    service.getThread('bob', ordinary.id),
    /THREAD_NOT_FOUND/,
  );
  members.delete('bob');
  await assert.rejects(
    service.withWorkspaceFiles(
      'bob',
      member.threadId,
      async (root) => root,
      'shared',
    ),
    /THREAD_NOT_FOUND/,
  );
  await service.shutdown();
});

test('room polling reconciles interrupted runs and unexpected suspension fails without waiting', async () => {
  const { memory, threads: stored } = fakeMemory();
  let emit!: ChatSessionContext['onEvent'];
  let aborted = 0;
  let closed = 0;
  const statuses: string[] = [];
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return '/workspace/project';
    },
    async personalSharedDirectory() {
      return '/workspace/shared';
    },
    async open(context) {
      emit = context.onEvent;
      return sessionStub({
        abort() {
          aborted++;
        },
        async close() {
          closed++;
        },
      });
    },
  });
  service.setGroupChatObserver(async (_binding, status, error) => {
    statuses.push(`${status}:${error ?? ''}`);
  });
  const binding = {
    roomId: room.id,
    memberId: member.id,
    role: 'bot' as const,
    threadId: member.threadId,
    userId: 'alice',
    title: 'Bot',
    settings,
  };
  await service.ensureGroupChatThread(binding);
  await memory.updateThread({
    id: member.threadId,
    title: 'Bot',
    metadata: { status: 'running', activeId: 'crashed-run' },
  });
  await service.ensureGroupChatThread(binding);
  assert.equal(stored.get(member.threadId)!.metadata!.error, 'RUN_INTERRUPTED');
  assert.ok(statuses.includes('failed:RUN_INTERRUPTED'));
  await service.runGroupChat('alice', member.threadId, {
    ...settings,
    id: 'room-event-123',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Wake up' }],
  });
  await emit({
    type: 'interaction',
    settings,
    interaction: {
      id: 'unexpected',
      runId: 'bad-run',
      toolCallId: 'bad-tool',
      kind: 'suspended',
      toolName: 'unexpected_dynamic_tool',
    },
  });
  await emit({ type: 'status', status: 'success', runId: 'bad-run' });
  const snapshot = await service.getThread('alice', member.threadId);
  assert.equal(snapshot.thread.status, 'failed');
  assert.equal(snapshot.thread.error, 'ROOM_SUSPEND_NOT_SUPPORTED');
  assert.equal(snapshot.toolInteractions?.length, 0);
  assert.equal(aborted, 1);
  assert.equal(closed, 1);
  await service.shutdown();
});
