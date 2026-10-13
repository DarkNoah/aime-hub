import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isToolUIPart, type UIMessage } from 'ai';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import type { ChatSessionEvent } from '../apps/server/src/modules/threads/session.js';
import { mergeMessages } from '../apps/web/src/components/chat/messages.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';
import {
  call,
  overlappingMessages,
} from './fixtures/thread-message-overlap.js';

test('runtime SSE coalesces live/stored aliases, cancels without losing the tail, and reconnects with late results', async (t) => {
  const { memory } = fakeMemory();
  let emit!: (event: ChatSessionEvent) => void;
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return 'workspace';
    },
    async open({ onEvent }) {
      emit = onEvent;
      return sessionStub();
    },
  });
  t.after(() => service.shutdown());
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const thread = await service.createThread('alice', settings);
  let visible: UIMessage[] = [];
  await service.subscribe('alice', thread.id, (snapshot) => {
    visible = mergeMessages(
      visible,
      snapshot.messages,
      false,
      snapshot.removedMessageIds,
    );
  });
  await service.run('alice', thread.id, {
    ...settings,
    id: 'user-message',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Begin' }],
  });
  const { draft, persisted } = overlappingMessages();
  emit({ type: 'status', status: 'running', runId: 'run' });
  emit({ type: 'message', active: true, message: draft });
  // Let the client receive the provisional ID before storage chooses another ID.
  await delay(100);
  emit({ type: 'message', active: false, message: persisted });
  await delay(100);
  const live = await service.getThread('alice', thread.id);
  assert.equal(live.thread.status, 'running');
  assert.equal(live.activeMessageId, persisted.id);
  assert.deepEqual(
    live.messages.map((m) => m.id),
    [persisted.id],
  );
  assert.deepEqual(
    visible.map((m) => m.id),
    [persisted.id],
  );
  await service.abort('alice', thread.id);
  emit({
    type: 'reconcile',
    messages: [persisted],
    removedMessageIds: [draft.id],
  });
  emit({
    type: 'message',
    active: false,
    message: { ...persisted, parts: [...persisted.parts, call('new-call')] },
  });
  await delay(100);
  const stopped = await service.getThread('alice', thread.id);
  assert.equal(stopped.thread.status, 'canceled');
  assert.equal(stopped.activeMessageId, null);
  assert.equal(stopped.messages.length, 1);
  assert.ok(
    stopped.messages[0].parts.some(
      (p) => p.type === 'text' && p.text === 'Not saved yet',
    ),
  );
  assert.ok(stopped.messages[0].parts.some((p) => p.type === 'file'));
  const tools = stopped.messages[0].parts.filter(isToolUIPart);
  assert.equal(tools.length, 17);
  assert.equal(tools.at(-1)?.state, 'output-available');
  let reconnected: UIMessage[] = [];
  await service.subscribe('alice', thread.id, (snapshot) => {
    reconnected = snapshot.messages;
  });
  assert.deepEqual(reconnected, stopped.messages);
  assert.deepEqual(visible, stopped.messages);
});
