import type { LanguageModelUsage } from '@mastra/core/stream';
import type { TokenCounts } from '@aime/shared/usage';

const count = (value: number | undefined): number | null =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

/** Keep missing values unknown; cache/reasoning counts are subsets, not extra totals. */
export function runtimeTokenCounts(
  usage: Partial<LanguageModelUsage>,
): TokenCounts {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      count(usage.totalTokens) ??
      (inputTokens !== null && outputTokens !== null
        ? count(inputTokens + outputTokens)
        : null),
    cachedInputTokens: count(usage.cachedInputTokens),
    cacheCreationInputTokens: count(usage.cacheCreationInputTokens),
    reasoningTokens: count(usage.reasoningTokens),
  };
}
