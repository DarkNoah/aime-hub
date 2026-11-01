import type { ProviderConfiguration } from '@aime/shared/provider-configuration';
import { requestWebResource, webUrl } from '../web/request.js';
import { allowAllNetworks } from '../../modules/network/policy.js';
import {
  BaseProvider,
  type WebFetchOptions,
  type WebFetchResult,
} from './base-provider.js';

export class JinaAIProvider extends BaseProvider {
  static override readonly configuration: ProviderConfiguration = {
    fields: [],
    description: {
      en: 'Jina AI reads web pages. Select it in Tools → Web fetch after saving.',
      'zh-CN': 'Jina AI 用于读取网页，保存后可在“工具 → 网页读取”中选择。',
    },
    baseUrlHint: {
      en: 'Use https://r.jina.ai as the Reader API root. Do not include a target page URL.',
      'zh-CN':
        '填写 Reader API 根地址 https://r.jina.ai，不要附加要读取的网页地址。',
    },
    defaultBaseUrl: 'https://r.jina.ai',
  };

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
      (!allowAllNetworks() && base.protocol !== 'https:') ||
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
