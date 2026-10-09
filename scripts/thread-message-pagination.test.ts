import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadSnapshot } from '@aime/shared/threads';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { threadMessages } from '../apps/server/src/modules/threads/message-conversion.js';
import { mergeMessages } from '../apps/web/src/components/chat/messages.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
type Message = ReturnType<typeof threadMessages>[number];

test('replayed history and reconnect snapshots stay ordered across the 40-message page boundary', async (t) => {
  const { memory, messages } = fakeMemory();
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() {
      return '/workspace/test';
    },
    async open({ onEvent }) {
      const history = threadMessages([...messages.values()]);
      // Native session history can be wider than the page that initialized the runtime.
      onEvent({ type: 'reconcile', messages: history, removedMessageIds: [] });
      onEvent({ type: 'message', message: history[0], active: false });
      return sessionStub();
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  for (let index = 0; index < 41; index++) {
    const id = `message-${index}`;
    messages.set(id, {
      id,
      role: index % 2 ? 'assistant' : 'user',
      threadId: thread.id,
      resourceId: 'user:alice',
      createdAt: new Date(1_700_000_000_000 + index),
      content: { format: 2, parts: [{ type: 'text', text: id }] },
    });
  }
  const page = await service.history('alice', thread.id);
  assert.equal(page.hasMore, true);
  assert.equal(page.messages[0].id, 'message-1');
  assert.deepEqual(
    (await service.getThread('alice', thread.id)).messages,
    page.messages,
  );

  await service.run('alice', thread.id, {
    ...settings,
    id: 'next-message',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Next' }],
  });
  const expected = threadMessages([...messages.values()]);
  const snapshot = await service.getThread('alice', thread.id);
  assert.deepEqual(snapshot.messages, expected);

  let reconnected: ThreadSnapshot<Message> | undefined;
  await service.subscribe('alice', thread.id, (value) => {
    reconnected = value;
  });
  assert.ok(reconnected);
  const initial = mergeMessages(page.messages, reconnected.messages);
  assert.deepEqual(initial, expected);
  const earlier = await service.history('alice', thread.id, 1, page.anchor);
  assert.equal(earlier.hasMore, false);
  assert.deepEqual(mergeMessages(initial, earlier.messages, true), expected);
});
