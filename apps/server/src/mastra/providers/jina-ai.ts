import { requestWebResource, webUrl } from '../web/request.js';
import {
  BaseProvider,
  type WebFetchOptions,
  type WebFetchResult,
} from './base-provider.js';

export class JinaAIProvider extends BaseProvider {
  readonly name = 'jina-ai';
  readonly type = 'jina-ai';
  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
    },
    private readonly request = requestWebResource,
  ) {
    super({ provider: { id: 'jina-ai', ...config } });
  }

  async webFetch(
    url: string,
    options?: WebFetchOptions,
  ): Promise<WebFetchResult> {
    webUrl(url);
    const base = webUrl(this.config.baseUrl);
    if (
      base.protocol !== 'https:' ||
      base.search ||
      base.hash ||
      !this.config.apiKey.trim()
    )
      throw new Error('Invalid reader provider configuration');
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.config.timeoutMs),
      ...(options?.abortSignal ? [options.abortSignal] : []),
    ]);
    signal.throwIfAborted();
    // POST preserves query strings and hash routes without embedding them in the API URL.
    const response = await this.request(base.href, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/plain',
        'x-respond-with': 'markdown',
        'x-with-generated-alt': 'true',
      },
      body: JSON.stringify({ url }),
    });
    signal.throwIfAborted();
    const content = response.body.toString('utf8').trim();
    if (response.status !== 200 || !content)
      throw new Error('Reader request failed');
    return { content, url, contentType: 'text/markdown' };
  }
}
