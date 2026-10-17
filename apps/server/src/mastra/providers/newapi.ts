import type { SpeechModelSettings } from './speech-model.js';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { z } from 'zod';
import {
  BaseProvider,
  type ProviderConfig,
  type ProviderModelInfo,
} from './base-provider.js';
import { requestWebResource, webUrl } from '../web/request.js';
import { createImageModel } from './image-model.js';
import { createSpeechModel } from './openai-compatible-speech.js';
import { createTranscriptionModel } from './openai-compatible-transcription.js';
import {
  createEmbeddingModel,
  createRerankModel,
} from './openai-compatible-retrieval.js';
import { allowAllNetworks } from '../../modules/network/policy.js';

type RequestOptions = {
  body?: unknown;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
};

const modelListResponse = z.object({
  data: z.array(
    z.object({ id: z.string().min(1), name: z.string().optional() }),
  ),
});
export class NewApiProvider extends BaseProvider {
  readonly name = 'newapi';
  readonly type = 'newapi';
  private readonly baseUrl: string;

  constructor(
    provider: ProviderConfig,
    private readonly request = requestWebResource,
  ) {
    super({ provider });
    const url = webUrl(provider.baseUrl);
    if (
      (!allowAllNetworks() && url.protocol !== 'https:') ||
      url.search ||
      url.hash ||
      !provider.apiKey?.trim()
    )
      throw new Error('Invalid New API provider configuration');
    const base = url.href.replace(/\/+$/, '');
    this.baseUrl = base.endsWith('/v1') ? base : `${base}/v1`;
  }

  languageModel(modelId: string): OpenAICompatibleConfig {
    if (!modelId.trim()) throw new Error('New API model ID is required');
    return {
      providerId: 'openai',
      modelId,
      url: this.baseUrl,
      apiKey: this.provider.apiKey!,
      api: 'responses',
    };
  }

  imageModel(modelId: string) {
    return createImageModel(
      { ...this.provider, baseUrl: this.baseUrl },
      modelId,
      this.request,
    );
  }

  speechModel(modelId: string, settings?: SpeechModelSettings) {
    return createSpeechModel(
      { ...this.provider, baseUrl: this.baseUrl, type: this.type },
      modelId,
      settings,
      this.request,
    );
  }

  async getLanguageModelList(): Promise<ProviderModelInfo[]> {
    const { data } = await this.requestJson('models', modelListResponse);
    return [
      ...new Map(
        data.data.map(({ id, name }) => [id, { id, name: name || id }]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id));
  }

  // New API's model list has no guaranteed capability field; use its available IDs.
  getEmbeddingModelList(): Promise<ProviderModelInfo[]> {
    return this.getLanguageModelList();
  }

  getRerankModelList(): Promise<ProviderModelInfo[]> {
    return this.getLanguageModelList();
  }

  textEmbeddingModel(modelId: string) {
    return createEmbeddingModel(
      { ...this.provider, baseUrl: this.baseUrl, type: this.type },
      modelId,
      this.request,
    );
  }

  rerankModel(modelId: string) {
    return createRerankModel(
      { ...this.provider, baseUrl: this.baseUrl, type: this.type },
      modelId,
      this.request,
    );
  }

  transcriptionModel(modelId: string) {
    return createTranscriptionModel(
      { ...this.provider, baseUrl: this.baseUrl, type: this.type },
      modelId,
      this.request,
    );
  }

  private async requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.provider.timeoutMs ?? 60_000),
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    signal.throwIfAborted();
    const headers = new Headers();
    for (const [name, value] of Object.entries(options.headers ?? {}))
      if (value !== undefined) headers.set(name, value);
    headers.set('authorization', `Bearer ${this.provider.apiKey}`);
    headers.set('content-type', 'application/json');
    const response = await this.request(`${this.baseUrl}/${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      signal,
      headers: Object.fromEntries(headers),
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      maxBytes: 20_000_000,
    });
    signal.throwIfAborted();
    if (response.status !== 200)
      throw new Error(`New API request failed (${response.status})`);
    let raw: unknown;
    try {
      raw = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new Error('Invalid New API JSON response');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid New API response');
    return {
      data: parsed.data,
      response: { headers: response.headers, body: raw },
    };
  }
}
