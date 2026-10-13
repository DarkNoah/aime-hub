import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentThreadSubscription } from '@mastra/core/agent';
import type { ChunkType } from '@mastra/core/stream';
import type { UIMessage } from 'ai';
import { consumeSessionStream } from './session-stream.js';
import type { ChatSessionEvent } from './session.js';

for (const ending of ['abort', 'error', 'finish', 'disconnect'] as const) {
  test(`native ${ending} reconciles the drained partial draft, even without a successful finish`, async () => {
    const chunks = [
      { type: 'start', payload: { messageId: 'stream-only' } },
      {
        type: 'step-start',
        payload: { messageId: 'stream-only', request: {} },
      },
      { type: 'text-start', payload: { id: 'text' } },
      {
        type: 'text-delta',
        payload: { id: 'text', text: 'Unsaved partial answer' },
      },
      ...(ending === 'disconnect'
        ? []
        : ending === 'finish'
          ? [
              {
                type: 'finish',
                payload: {
                  stepResult: { reason: 'stop' },
                  output: { usage: {} },
                },
              },
            ]
          : [
              {
                type: ending,
                payload:
                  ending === 'error'
                    ? { error: new Error('Provider failed') }
                    : {},
              },
            ]),
    ].map((chunk) => ({
      ...chunk,
      runId: 'run',
      from: 'AGENT',
    })) as ChunkType[];
    const subscription = {
      activeRunId: () => 'run',
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    } as unknown as AgentThreadSubscription<unknown, true>;
    const messages = new Map<string, UIMessage>();
    const events: ChatSessionEvent[] = [];
    const reconciled: string[][] = [];
    await consumeSessionStream(
      subscription,
      messages,
      () => ({ model: null, reasoningEffort: 'auto' }),
      (event) => events.push(structuredClone(event)),
      () => {},
      async (ids) => {
        reconciled.push(ids);
        assert.ok(
          messages
            .get('stream-only')
            ?.parts.some(
              (p) => p.type === 'text' && p.text === 'Unsaved partial answer',
            ),
        );
      },
    );
    assert.deepEqual(reconciled, [['stream-only']]);
    if (ending === 'abort' || ending === 'finish')
      assert.ok(
        events.some(
          (event) =>
            event.type === 'status' &&
            event.status === (ending === 'abort' ? 'canceled' : 'success'),
        ),
      );
  });
}
