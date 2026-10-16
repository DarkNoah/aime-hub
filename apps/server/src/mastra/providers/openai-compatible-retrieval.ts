import type { EmbeddingModel, RerankingModel } from 'ai';
import { z } from 'zod';
import type { ProviderConfig } from './base-provider.js';
import { requestWebResource, webUrl } from '../web/request.js';
import { allowAllNetworks } from '../../modules/network/policy.js';

type RetrievalProviderConfig = ProviderConfig & { type: string };
type RequestOptions = {
  body: unknown;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
};

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

function createRequest(
  provider: ProviderConfig,
  modelId: string,
  request: typeof requestWebResource,
) {
  const url = webUrl(provider.baseUrl);
  if (
    (!allowAllNetworks() && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    !modelId.trim()
  )
    throw new Error('Invalid OpenAI-compatible provider configuration');
  const baseUrl = url.href.replace(/\/+$/, '');

  return async <T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions,
  ) => {
    const signal = AbortSignal.any([
      AbortSignal.timeout(provider.timeoutMs ?? 60_000),
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    signal.throwIfAborted();
    const headers = new Headers();
    for (const [name, value] of Object.entries(options.headers ?? {}))
      if (value !== undefined) headers.set(name, value);
    if (provider.apiKey)
      headers.set('authorization', `Bearer ${provider.apiKey}`);
    headers.set('content-type', 'application/json');
    const response = await request(`${baseUrl}/${path}`, {
      method: 'POST',
      signal,
      headers: Object.fromEntries(headers),
      body: JSON.stringify(options.body),
      maxBytes: 20_000_000,
    });
    signal.throwIfAborted();
    if (response.status !== 200)
      throw new Error(`OpenAI-compatible request failed (${response.status})`);
    let raw: unknown;
    try {
      raw = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new Error('Invalid OpenAI-compatible JSON response');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid OpenAI-compatible response');
    return {
      data: parsed.data,
      response: { headers: response.headers, body: raw },
    };
  };
}

/** Embeddings and rerank protocols shared by compatible providers and New API. */
export function createEmbeddingModel(
  provider: RetrievalProviderConfig,
  modelId: string,
  request = requestWebResource,
): EmbeddingModel {
  const requestJson = createRequest(provider, modelId, request);
  return {
    specificationVersion: 'v3',
    provider: provider.type,
    modelId,
    maxEmbeddingsPerCall: 2048,
    supportsParallelCalls: true,
    doEmbed: async ({ values, providerOptions, ...requestOptions }) => {
      const dimensions = z
        .number()
        .int()
        .positive()
        .optional()
        .parse(providerOptions?.[provider.type]?.dimensions);
      const { data, response } = await requestJson(
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
        throw new Error('Invalid OpenAI-compatible embedding indices');
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

export function createRerankModel(
  provider: RetrievalProviderConfig,
  modelId: string,
  request = requestWebResource,
): RerankingModel {
  const requestJson = createRequest(provider, modelId, request);
  return {
    specificationVersion: 'v3',
    provider: provider.type,
    modelId,
    doRerank: async ({ documents, query, topN, ...requestOptions }) => {
      const limit = z.number().int().positive().optional().parse(topN);
      const { data, response } = await requestJson('rerank', rerankResponse, {
        ...requestOptions,
        body: {
          model: modelId,
          query,
          documents: documents.values,
          top_n: limit,
          // AI SDK restores the original documents using the returned indices.
          return_documents: false,
        },
      });
      if (
        new Set(data.results.map((item) => item.index)).size !==
          data.results.length ||
        data.results.some((item) => item.index >= documents.values.length)
      )
        throw new Error('Invalid OpenAI-compatible rerank indices');
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
