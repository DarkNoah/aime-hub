import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { EmbeddingModel, RerankingModel } from 'ai';
import { z } from 'zod';
import {
  BaseProvider,
  type ProviderConfig,
  type ProviderModelInfo,
} from './base-provider.js';
import { requestWebResource, webUrl } from '../web/request.js';
import { createImageModel } from './image-model.js';
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
const embeddingResponse = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()).min(1),
    }),
  ),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative() }).optional(),
});
const rerankResponse = z.object({
  id: z.string().optional(),
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      relevance_score: z.number(),
    }),
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

  textEmbeddingModel(modelId: string): EmbeddingModel {
    if (!modelId.trim()) throw new Error('New API model ID is required');
    return {
      specificationVersion: 'v3',
      provider: this.name,
      modelId,
      maxEmbeddingsPerCall: 2048,
      supportsParallelCalls: true,
      doEmbed: async ({ values, providerOptions, ...requestOptions }) => {
        const dimensions = z
          .number()
          .int()
          .positive()
          .optional()
          .parse(providerOptions?.newapi?.dimensions);
        const { data, response } = await this.requestJson(
          'embeddings',
          embeddingResponse,
          {
            ...requestOptions,
            body: {
              model: modelId,
              input: values,
              encoding_format: 'float',
              dimensions,
            },
          },
        );
        if (
          data.data.length !== values.length ||
          new Set(data.data.map((item) => item.index)).size !== values.length ||
          data.data.some((item) => item.index >= values.length)
        )
          throw new Error('Invalid New API embedding indices');
        return {
          // AI SDK requires vectors in input order, regardless of response order.
          embeddings: data.data
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding),
          usage: data.usage ? { tokens: data.usage.prompt_tokens } : undefined,
          warnings: [],
          response,
        };
      },
    };
  }

  rerankModel(modelId: string): RerankingModel {
    if (!modelId.trim()) throw new Error('New API model ID is required');
    return {
      specificationVersion: 'v3',
      provider: this.name,
      modelId,
      doRerank: async ({ documents, query, topN, ...requestOptions }) => {
        const limit = z.number().int().positive().optional().parse(topN);
        const { data, response } = await this.requestJson(
          'rerank',
          rerankResponse,
          {
            ...requestOptions,
            body: {
              model: modelId,
              query,
              documents: documents.values,
              top_n: limit,
              // AI SDK restores the original documents using the returned indices.
              return_documents: false,
            },
          },
        );
        if (
          new Set(data.results.map((item) => item.index)).size !==
            data.results.length ||
          data.results.some((item) => item.index >= documents.values.length)
        )
          throw new Error('Invalid New API rerank indices');
        return {
          ranking: data.results
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .slice(0, limit)
            .map(({ index, relevance_score }) => ({
              index,
              relevanceScore: relevance_score,
            })),
          warnings: [],
          response: { ...response, id: data.id, modelId },
        };
      },
    };
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
