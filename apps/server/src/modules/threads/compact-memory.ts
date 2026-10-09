import type { Memory } from '@mastra/memory';
import { ObservationalMemory } from '@mastra/memory/processors';
import type { ObservationalMemoryConfig } from '@mastra/memory/processors';

/** Call only while the thread is idle and its application lock is held. */
export async function compactMemory(
  memory: Memory,
  target: { threadId: string; resourceId: string },
  model: ObservationalMemoryConfig['model'],
) {
  await memory.settled();
  const engine = await memory.omEngine;
  if (!engine) throw new Error('Observational memory is not enabled');
  const record = await engine.getOrCreateRecord(
    target.threadId,
    target.resourceId,
  );
  const overrides = record.config?._overrides as
    { observation?: { messageTokens?: unknown } } | undefined;
  const previousThreshold = overrides?.observation?.messageTokens ?? null;
  // The normal engine clamps thresholds below its async buffering floor.
  // Use a synchronous observer over the same store without changing that engine.
  const manual = new ObservationalMemory({
    storage: engine.getStorage(),
    memory,
    scope: 'thread',
    model,
    observation: {
      messageTokens: 1,
      bufferTokens: false,
      failurePolicy: 'abort',
    },
  });
  try {
    await memory.updateObservationalMemoryConfig({
      ...target,
      config: { observation: { messageTokens: 1 } },
    });
    const result = await manual.observe(target);
    return { observed: result.observed };
  } finally {
    // null removes the effective override and lets the normal engine's default
    // apply again. Preserve custom thresholds (including ranges), never hardcode 30k.
    try {
      await manual.settled();
    } finally {
      await memory.updateObservationalMemoryConfig({
        ...target,
        config: { observation: { messageTokens: previousThreshold } },
      });
    }
  }
}
