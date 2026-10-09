import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { compactMemory } from './compact-memory.js';

const target = { threadId: 'compact-thread', resourceId: 'user:alice' };

async function fixture(fail = false) {
  let calls = 0;
  const output = () => {
    calls++;
    if (fail) throw new Error('Observer unavailable');
    return '<observations>\nDate: Oct 9, 2026\n- User prefers Chinese and is building a chat app.\n</observations>';
  };
  const model = new MastraLanguageModelV2Mock({
    doGenerate: async () => ({
      content: [{ type: 'text', text: output() }],
      finishReason: 'stop',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      warnings: [],
    }),
    doStream: async () => {
      const text = output();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'observation' });
            controller.enqueue({
              type: 'text-delta',
              id: 'observation',
              delta: text,
            });
            controller.enqueue({ type: 'text-end', id: 'observation' });
            controller.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
            });
            controller.close();
          },
        }),
      };
    },
  });
  const storage = new InMemoryStore();
  const memory = new Memory({
    storage,
    options: {
      generateTitle: false,
      observationalMemory: { model, scope: 'thread' },
    },
  });
  await memory.createThread(target);
  const seed = () =>
    memory.saveMessages({
      messages: [
        {
          id: 'user-message',
          ...target,
          role: 'user',
          createdAt: new Date('2026-10-09T01:00:00Z'),
          content: {
            format: 2,
            parts: [
              {
                type: 'text',
                text: 'Please remember that I prefer Chinese. I am building a chat app.',
              },
            ],
          },
        },
        {
          id: 'assistant-message',
          ...target,
          role: 'assistant',
          createdAt: new Date('2026-10-09T01:00:01Z'),
          content: {
            format: 2,
            parts: [
              {
                type: 'text',
                text: 'I will use Chinese for this chat app project.',
              },
            ],
          },
        },
      ],
    });
  const engine = (await memory.omEngine)!;
  return { memory, engine, model, seed, calls: () => calls };
}

for (const threshold of [undefined, 64_000, { min: 40_000, max: 60_000 }]) {
  test(`manual compaction bypasses buffering and restores threshold ${JSON.stringify(threshold)}`, async () => {
    const { memory, model, engine, seed, calls } = await fixture();
    await seed();
    await engine.getOrCreateRecord(target.threadId, target.resourceId);
    if (threshold !== undefined)
      await memory.updateObservationalMemoryConfig({
        ...target,
        config: {
          observation: { messageTokens: threshold },
          reflection: { observationTokens: 75_000 },
        },
      });
    assert.equal((await engine.observe(target)).observed, false);
    assert.equal(calls(), 0);
    assert.deepEqual(await compactMemory(memory, target, model), {
      observed: true,
    });
    assert.ok(calls() > 0);
    const record = (await engine.getRecord(
      target.threadId,
      target.resourceId,
    ))!;
    assert.match(record.activeObservations, /prefers Chinese/);
    const overrides = record.config?._overrides as {
      observation: { messageTokens: unknown };
      reflection?: { observationTokens: number };
    };
    assert.deepEqual(overrides.observation.messageTokens, threshold ?? null);
    if (threshold !== undefined)
      assert.equal(overrides.reflection?.observationTokens, 75_000);
    const history = await memory.recall({ ...target, perPage: false });
    assert.equal(
      history.messages.length,
      2,
      'compression adds no user or assistant turn',
    );
    assert.ok(
      history.messages.some((message) =>
        message.content.parts.some(
          (part) => part.type === 'data-om-observation-end',
        ),
      ),
    );
    const observedCalls = calls();
    assert.deepEqual(await compactMemory(memory, target, model), {
      observed: false,
    });
    assert.equal(
      calls(),
      observedCalls,
      'already observed messages do not call the model again',
    );
    await memory.settled();
  });
}

test('empty conversations are a no-op without a provider call', async () => {
  const { memory, engine, model, calls } = await fixture();
  assert.deepEqual(await compactMemory(memory, target, model), {
    observed: false,
  });
  assert.equal(calls(), 0);
  assert.equal((await engine.observe(target)).observed, false);
});

test('observer failure restores the custom threshold and keeps the original messages', async () => {
  const { memory, engine, model, seed } = await fixture(true);
  await seed();
  await engine.getOrCreateRecord(target.threadId, target.resourceId);
  await memory.updateObservationalMemoryConfig({
    ...target,
    config: { observation: { messageTokens: 48_000 } },
  });
  await assert.rejects(compactMemory(memory, target, model));
  const record = (await engine.getRecord(target.threadId, target.resourceId))!;
  assert.deepEqual(record.config?._overrides, {
    observation: { messageTokens: 48_000 },
  });
  assert.equal(
    (await memory.recall({ ...target, perPage: false })).messages.length,
    2,
  );
});
