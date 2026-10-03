import { setTimeout } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const sleep = createTool({
  id: 'sleep',
  description:
    'Simulate a long-running task to test background execution. Wait for the requested duration and return timing information. Does not perform real research.',
  inputSchema: z.object({
    label: z.string().optional().describe('Label for the test task'),
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
    status: z.string(),
    elapsedMs: z.number(),
    completedAt: z.string(),
  }),
  background: {
    enabled: true,
    defaultDisposition: 'deferred',
    // timeoutMs: 600_000,
    // maxRetries: 1,
  },
  execute: async ({ durationMs }, context) => {
    const startedAt = performance.now();
    await setTimeout(durationMs, undefined, { signal: context?.abortSignal });

    return {
      status: context?.abortSignal?.aborted === true ? 'aborted' : 'completed',
      elapsedMs: Math.round(performance.now() - startedAt),
      completedAt: new Date().toISOString(),
    };
  },
});
