import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  defaultWebSearchConfig,
  type WebSearchConfig,
} from '@aime/shared/tools';
import {
  searchResultSchema,
  type BaseProvider,
} from '../providers/base-provider.js';
import { LocalProvider } from '../providers/local.js';

export function createWebSearchTool(
  config: WebSearchConfig = defaultWebSearchConfig,
  dependencies: {
    resolveProvider?: (
      id: string,
    ) => Promise<Pick<BaseProvider, 'id' | 'webSearch'>>;
    fallbackProvider?: Pick<BaseProvider, 'id' | 'webSearch'>;
  } = {},
) {
  const fallback =
    dependencies.fallbackProvider ??
    new LocalProvider({ timeoutMs: config.timeoutMs });
  return createTool({
    id: 'web_search',
    description:
      'Search the web for current information. Returns titles, URLs and snippets. Cite the result URLs in your answer. Use web_fetch to read a full page when needed.',
    inputSchema: z.strictObject({
      query: z.string().trim().describe('The search query'),
    }),
    outputSchema: z.object({
      results: z.array(searchResultSchema),
      provider: z.string(),
      fallback: z.boolean(),
      isError: z.boolean().optional(),
      message: z.string().optional(),
    }),
    execute: async ({ query }, context) => {
      const input = { query, numResults: config.numResults };
      const options = { abortSignal: context?.abortSignal };
      const aborted = () => ({
        results: [],
        provider: 'none',
        fallback: false,
        isError: true,
        message: 'Web search was cancelled.',
      });
      if (options.abortSignal?.aborted) return aborted();
      if (config.providerId && dependencies.resolveProvider) {
        try {
          const provider = await dependencies.resolveProvider(
            config.providerId,
          );
          if (options.abortSignal?.aborted) return aborted();
          const results = await provider.webSearch(input, options);
          if (options.abortSignal?.aborted) return aborted();
          return { results, provider: provider.id, fallback: false };
        } catch {
          // Do not leak credential-bearing request URLs or upstream errors.
          if (options.abortSignal?.aborted) return aborted();
        }
      }
      try {
        const results = await fallback.webSearch(input, options);
        if (options.abortSignal?.aborted) return aborted();
        return { results, provider: fallback.id, fallback: true };
      } catch {
        if (options.abortSignal?.aborted) return aborted();
        return {
          results: [],
          provider: fallback.id,
          fallback: true,
          isError: true,
          message: 'Web search failed. Please try again later.',
        };
      }
    },
  });
}

export const webSearch = createWebSearchTool();
