import type { LanguageModelUsage } from '@mastra/core/stream';
import type { ChatUsage } from '@aime/shared/threads';
import type { ResolvedChatModel } from '../models/language-model.js';

export function getChatUsage(
  usage: LanguageModelUsage,
  model: Pick<ResolvedChatModel, 'reference' | 'maxContextTokens'>,
): ChatUsage {
  const count = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  return {
    model: model.reference,
    maxTokens: model.maxContextTokens ?? null,
    inputTokens,
    outputTokens,
    totalTokens:
      count(usage.totalTokens) ??
      (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined),
    reasoningTokens: count(usage.reasoningTokens),
    cachedInputTokens: count(usage.cachedInputTokens),
    cacheCreationInputTokens: count(usage.cacheCreationInputTokens),
  };
}
