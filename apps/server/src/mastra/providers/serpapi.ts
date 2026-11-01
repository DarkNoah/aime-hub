import type { ProviderConfiguration } from '@aime/shared/provider-configuration';
import { z } from 'zod';
import { requestProviderJson } from '../../modules/providers/network.js';
import { searchResultUrl } from '../web/request.js';
import {
  BaseProvider,
  type SearchResult,
  type WebSearchInput,
  type WebSearchOptions,
} from './base-provider.js';

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

export class SerpApiProvider extends BaseProvider {
  static override readonly configuration: ProviderConfiguration = {
    fields: [],
    description: {
      en: 'SerpAPI provides web search. Select it in Tools → Web search after saving.',
      'zh-CN':
        'SerpAPI 提供网页搜索能力，保存后可在「工具配置 → 网页搜索」中选择。',
    },
    baseUrlHint: {
      en: 'Use https://serpapi.com as the API root. Do not include /search.json or query parameters.',
      'zh-CN':
        'API 根地址填写 https://serpapi.com，不要附加 /search.json 或查询参数。',
    },
    defaultBaseUrl: 'https://serpapi.com',
  };

  readonly name = 'serpapi';
  readonly type = 'serpapi';
  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      timeoutMs: number;
    },
    private readonly requestJson = requestProviderJson,
  ) {
    super({ provider: { id: 'serpapi', ...config } });
  }

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
