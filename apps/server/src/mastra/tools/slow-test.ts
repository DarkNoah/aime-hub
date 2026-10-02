import { setTimeout as sleep } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const slowTestTool = createTool({
  id: 'slow-test',
  description:
    'Simulate a long-running task to test background execution. Wait for the requested duration and return timing information. Does not perform real research.',
  inputSchema: z.object({
    topic: z.string().trim().min(1).describe('Label for the test task'),
    durationMs: z
      .number()
      .int()
      .min(1)
      .max(540_000)
      .default(30_000)
      .describe(
        'Simulated task duration in milliseconds; defaults to 30 seconds',
      ),
  }),
  outputSchema: z.object({
    status: z.literal('completed'),
    topic: z.string(),
    durationMs: z.number(),
    elapsedMs: z.number(),
    completedAt: z.string(),
  }),
  background: {
    enabled: true,
    defaultDisposition: 'deferred',
    timeoutMs: 600_000,
    maxRetries: 1,
  },
  execute: async ({ topic, durationMs }, context) => {
    const startedAt = performance.now();
    await sleep(durationMs, undefined, { signal: context?.abortSignal });

    return {
      status: 'completed' as const,
      topic,
      durationMs,
      elapsedMs: Math.round(performance.now() - startedAt),
      completedAt: new Date().toISOString(),
    };
  },
});
