import { z } from 'zod';
import { allowAllNetworks } from '../../modules/network/policy.js';
import { requestProviderJson } from '../../modules/providers/network.js';
import { requestWebResource, searchResultUrl, webUrl } from '../web/request.js';
import type {
  ProviderConfig,
  SearchResult,
  WebFetchOptions,
  WebFetchResult,
  WebSearchInput,
  WebSearchOptions,
} from './base-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      summary: z.string().optional(),
    }),
  ),
});
const fetchResponseSchema = z.object({
  title: z.string(),
  content: z.string(),
});

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(
    provider: ProviderConfig,
    requestJson = requestProviderJson,
    private readonly requestTools = requestWebResource,
  ) {
    super({ ...provider, type: 'deepseek' }, requestJson, requestTools);
  }

  private async requestTool(
    tool: 'search' | 'fetch',
    body: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    const base = webUrl(this.provider.baseUrl);
    if (
      (!allowAllNetworks() && base.protocol !== 'https:') ||
      base.search ||
      base.hash ||
      !this.provider.apiKey?.trim()
    )
      throw new Error('Invalid DeepSeek provider configuration');
    // Accept the API root, /v1, and either form behind a proxy prefix.
    const path = base.pathname.replace(/\/+$/, '');
    base.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/tools/${tool}`;
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.provider.timeoutMs ?? 15000),
      ...(abortSignal ? [abortSignal] : []),
    ]);
    signal.throwIfAborted();
    try {
      const response = await this.requestTools(base.href, {
        method: 'POST',
        signal,
        maxBytes: tool === 'search' ? 2_000_000 : 5_000_000,
        headers: {
          authorization: `Bearer ${this.provider.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      signal.throwIfAborted();
      if (response.status !== 200) throw new Error('Request failed');
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      signal.throwIfAborted();
      // Upstream responses and transport errors may contain credentials.
      throw new Error(`DeepSeek ${tool} request failed`);
    }
  }

  async webSearch(
    { query, numResults }: WebSearchInput,
    options?: WebSearchOptions,
  ): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || [...normalizedQuery].length > 128)
      throw new Error('DeepSeek search query must contain 1–128 characters');
    if (!Number.isInteger(numResults) || numResults < 1)
      throw new Error('Invalid DeepSeek search result count');
    const count = Math.min(numResults, 50);
    const parsed = searchResponseSchema.safeParse(
      await this.requestTool(
        'search',
        { query: normalizedQuery, count },
        options?.abortSignal,
      ),
    );
    if (!parsed.success) throw new Error('Invalid DeepSeek search response');
    return parsed.data.results
      .flatMap(({ title, url, snippet, summary }) => {
        const href = searchResultUrl(url);
        return href && title.trim()
          ? [{ title: title.trim(), href, snippet, summary }]
          : [];
      })
      .slice(0, count);
  }

  async webFetch(
    url: string,
    options?: WebFetchOptions,
  ): Promise<WebFetchResult> {
    webUrl(url);
    const parsed = fetchResponseSchema.safeParse(
      await this.requestTool('fetch', { url }, options?.abortSignal),
    );
    if (!parsed.success || !parsed.data.content.trim())
      throw new Error('Invalid DeepSeek fetch response');
    return { ...parsed.data, url, contentType: 'text/markdown' };
  }
}
