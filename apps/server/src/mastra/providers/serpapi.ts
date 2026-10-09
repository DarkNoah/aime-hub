import { z } from 'zod';
import { requestProviderJson } from '../../modules/providers/network.js';
import {
  searchResultUrl,
  type SearchResult,
  type WebSearchInput,
  type WebSearchOptions,
  type WebSearchProvider,
} from './web-search.js';

const responseSchema = z.object({
  search_metadata: z.object({ status: z.string() }).optional(),
  search_information: z
    .object({ organic_results_state: z.string().optional() })
    .optional(),
  error: z.string().optional(),
  organic_results: z
    .array(
      z.object({
        title: z.string(),
        link: z.string(),
        snippet: z.string().optional(),
      }),
    )
    .optional(),
});

export class SerpApiProvider implements WebSearchProvider {
  readonly id = 'serpapi';
  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      timeoutMs: number;
    },
    private readonly requestJson = requestProviderJson,
  ) {}

  async webSearch(
    { query, numResults }: WebSearchInput,
    options?: WebSearchOptions,
  ): Promise<SearchResult[]> {
    if (!this.config.apiKey.trim())
      throw new Error('Search provider API key is missing');
    const raw = await this.requestJson(
      `${this.config.baseUrl.replace(/\/+$/, '')}/search.json`,
      this.config.apiKey,
      2_000_000,
      {
        query: { engine: 'google', q: query },
        apiKeyParameter: 'api_key',
        signal: options?.abortSignal,
        timeoutMs: this.config.timeoutMs,
      },
    );
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid search provider response');
    const data = parsed.data;
    // SerpAPI marks a successful, empty search with a top-level error too.
    const empty =
      data.search_metadata?.status === 'Success' &&
      data.search_information?.organic_results_state?.toLowerCase() ===
        'fully empty';
    if (empty) return [];
    if (
      data.error ||
      (data.search_metadata && data.search_metadata.status !== 'Success') ||
      !data.organic_results
    )
      throw new Error('Search provider could not complete the search');
    return data.organic_results
      .flatMap(({ title, link, snippet }) => {
        const href = searchResultUrl(link);
        return href && title.trim()
          ? [{ title: title.trim(), href, snippet }]
          : [];
      })
      .slice(0, numResults);
  }
}
