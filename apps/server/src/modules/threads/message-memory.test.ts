import assert from 'node:assert/strict';
import test from 'node:test';
import { convertMessages } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import type { UIMessage } from 'ai';
import { ThreadMessageMemory } from './message-memory.js';

class TestMemory extends ThreadMessageMemory {
  messageStore() {
    return this.getMemoryStore();
  }
}

async function fixture() {
  const storage = new InMemoryStore();
  const received: UIMessage[] = [];
  const memory = new TestMemory(
    { storage, options: { semanticRecall: false, generateTitle: false } },
    { threadId: 'thread', resourceId: 'alice' },
    (message) => received.push(message),
  );
  await memory.createThread({ threadId: 'thread', resourceId: 'alice' });
  const pending: UIMessage = {
    id: 'assistant',
    role: 'assistant',
    parts: [
      {
        type: 'tool-sleep',
        toolCallId: 'sleep',
        state: 'input-available',
        input: {},
      },
    ],
  };
  const completed: UIMessage = {
    ...pending,
    parts: [
      {
        type: 'tool-sleep',
        toolCallId: 'sleep',
        state: 'output-available',
        input: {},
        output: { status: 'aborted' },
      },
    ],
  };
  const db = (message: UIMessage) =>
    convertMessages([message])
      .to('Mastra.V2')
      .map((message) => ({
        ...message,
        content: JSON.parse(JSON.stringify(message.content)),
        threadId: 'thread',
        resourceId: 'alice',
      }));
  return {
    storage,
    memory,
    received,
    pending: db(pending),
    completed: db(completed),
  };
}

test('direct native storage writes publish canceled results without output processors', async () => {
  const f = await fixture();
  const store = await f.memory.messageStore();
  await store.saveMessages({ messages: f.pending });
  assert.equal(f.received.length, 1);
  await store.saveMessages({ messages: f.completed });
  assert.equal(f.received.length, 2);
  assert.equal(f.received[1].parts[0].type, 'tool-sleep');
  assert.equal(
    'state' in f.received[1].parts[0] && f.received[1].parts[0].state,
    'output-available',
  );
  assert.deepEqual(
    (await store.listMessagesById({ messageIds: ['assistant'] })).messages[0]
      .content,
    f.completed[0].content,
  );
  // Other runs still use the unmodified shared store and cannot notify this run.
  await (await f.storage.getStore('memory'))!.saveMessages({
    messages: f.completed,
  });
  assert.equal(f.received.length, 2);
});

test('native saves are serialized before results are published', async () => {
  const f = await fixture();
  const raw = (await f.storage.getStore('memory'))!;
  const save = raw.saveMessages.bind(raw);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let partialStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    partialStarted = resolve;
  });
  let calls = 0;
  raw.saveMessages = async (args) => {
    if (++calls === 1) {
      partialStarted();
      await gate;
    }
    return save(args);
  };
  const partial = (await f.memory.messageStore()).saveMessages({
    messages: f.pending,
  });
  await started;
  const native = (await f.memory.messageStore()).saveMessages({
    messages: f.completed,
  });
  await Promise.resolve();
  assert.equal(f.received.length, 0);
  release();
  await Promise.all([partial, native]);
  assert.equal(f.received.length, 2);
  assert.deepEqual(
    (await raw.listMessagesById({ messageIds: ['assistant'] })).messages[0]
      .content,
    f.completed[0].content,
  );
});

test('a failed native save does not poison later saves', async () => {
  const f = await fixture();
  const raw = (await f.storage.getStore('memory'))!;
  const save = raw.saveMessages.bind(raw);
  raw.saveMessages = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(
    (await f.memory.messageStore()).saveMessages({ messages: f.completed }),
    /storage unavailable/,
  );
  assert.equal(f.received.length, 0);
  raw.saveMessages = save;
  await (await f.memory.messageStore()).saveMessages({ messages: f.pending });
  assert.deepEqual(
    (await raw.listMessagesById({ messageIds: ['assistant'] })).messages[0]
      .content,
    f.pending[0].content,
  );
});
