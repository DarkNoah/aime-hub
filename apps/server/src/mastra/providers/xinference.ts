import type { EmbeddingModel, RerankingModel, SpeechModel } from 'ai';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { z } from 'zod';
import {
  BaseProvider,
  type ProviderConfig,
  type ProviderModelInfo,
} from './base-provider.js';
import {
  requestWebResource,
  webUrl,
  type WebRequestOptions,
} from '../web/request.js';

const modelsResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(256),
        model_name: z.string().optional(),
        model_type: z.string(),
        model_ability: z.array(z.string()).default([]),
        max_tokens: z.number().int().positive().nullish(),
      }),
    )
    .max(10000),
});
const embeddingsResponse = z.object({
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
const speechOptions = z
  .object({
    // Base64 bytes, never a path or URL to fetch from the application server.
    promptSpeech: z
      .string()
      .min(1)
      .max(28_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
    promptSpeechMediaType: z
      .enum(['audio/wav', 'audio/mpeg', 'audio/flac', 'audio/ogg'])
      .default('audio/wav'),
    kwargs: z.record(z.string(), z.json()).default({}),
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
  })
  .strict();

export class XinferenceProvider extends BaseProvider {
  readonly name = 'xinference';
  readonly type = 'xinference';
  private readonly baseUrl: string;

  constructor(
    provider: ProviderConfig,
    private readonly request = requestWebResource,
  ) {
    super({ provider });
    const url = webUrl(provider.baseUrl);
    if (url.search || url.hash)
      throw new Error('Invalid Xinference provider configuration');
    const base = url.href.replace(/\/+$/, '');
    this.baseUrl = base.endsWith('/v1') ? base : `${base}/v1`;
  }

  languageModel(modelId: string): OpenAICompatibleConfig {
    this.assertModelId(modelId);
    return {
      providerId: 'openai',
      modelId,
      url: this.baseUrl,
      apiKey: this.provider.apiKey ?? '',
      api: 'chat',
    };
  }

  async getModelList(): Promise<ProviderModelInfo[]> {
    const { data } = await this.requestJson('models', modelsResponse);
    const models = data.data.flatMap((model): ProviderModelInfo[] => {
      const rawType = model.model_type.toLowerCase();
      const modelType =
        rawType === 'llm'
          ? 'language'
          : rawType === 'embedding' || rawType === 'rerank' || rawType === 'asr'
            ? rawType
            : rawType === 'audio' &&
                model.model_ability.some((ability) =>
                  ability.startsWith('text2audio'),
                )
              ? 'speech'
              : rawType === 'audio' &&
                  model.model_ability.some((ability) =>
                    ability.startsWith('audio2text'),
                  )
                ? 'asr'
                : undefined;
      // Do not expose unrecognized model types as chat models.
      if (!modelType) return [];
      return [
        {
          id: model.id,
          name: model.model_name || model.id,
          modelType,
          modalitiesInput:
            modelType === 'asr'
              ? ['audio']
              : [
                  'text',
                  ...(model.model_ability.includes('vision')
                    ? ['image' as const]
                    : []),
                ],
          modalitiesOutput:
            modelType === 'speech'
              ? ['audio']
              : modelType === 'language' || modelType === 'asr'
                ? ['text']
                : [],
          limitContext: model.max_tokens ?? null,
        },
      ];
    });
    return [...new Map(models.map((model) => [model.id, model])).values()].sort(
      (a, b) => a.id.localeCompare(b.id),
    );
  }

  async getLanguageModelList() {
    return (await this.getModelList()).filter(
      (model) => model.modelType === 'language',
    );
  }
  async getEmbeddingModelList() {
    return (await this.getModelList()).filter(
      (model) => model.modelType === 'embedding',
    );
  }
  async getRerankModelList() {
    return (await this.getModelList()).filter(
      (model) => model.modelType === 'rerank',
    );
  }
  async getSpeechModelList() {
    return (await this.getModelList()).filter(
      (model) => model.modelType === 'speech',
    );
  }

  textEmbeddingModel(modelId: string): EmbeddingModel {
    this.assertModelId(modelId);
    return {
      specificationVersion: 'v3',
      provider: this.name,
      modelId,
      maxEmbeddingsPerCall: 2048,
      supportsParallelCalls: true,
      doEmbed: async ({ values, providerOptions, ...options }) => {
        const dimensions = z
          .number()
          .int()
          .positive()
          .optional()
          .parse(providerOptions?.xinference?.dimensions);
        const { data, response } = await this.requestJson(
          'embeddings',
          embeddingsResponse,
          {
            ...options,
            body: JSON.stringify({
              model: modelId,
              input: values,
              encoding_format: 'float',
              dimensions,
            }),
          },
        );
        if (
          data.data.length !== values.length ||
          new Set(data.data.map((item) => item.index)).size !== values.length ||
          data.data.some((item) => item.index >= values.length)
        )
          throw new Error('Invalid Xinference embedding indices');
        return {
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
    this.assertModelId(modelId);
    return {
      specificationVersion: 'v3',
      provider: this.name,
      modelId,
      doRerank: async ({ documents, query, topN, ...options }) => {
        if (documents.type !== 'text')
          throw new Error('Xinference rerank requires text documents');
        const limit = z.number().int().positive().optional().parse(topN);
        const { data, response } = await this.requestJson(
          'rerank',
          rerankResponse,
          {
            ...options,
            body: JSON.stringify({
              model: modelId,
              query,
              documents: documents.values,
              top_n: limit,
              return_documents: false,
            }),
          },
        );
        if (
          new Set(data.results.map((item) => item.index)).size !==
            data.results.length ||
          data.results.some((item) => item.index >= documents.values.length)
        )
          throw new Error('Invalid Xinference rerank indices');
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

  speechModel(modelId: string, settings?: { modelName?: string }): SpeechModel {
    this.assertModelId(modelId);
    const isVoxCPM = /voxcpm/i.test(settings?.modelName ?? modelId);
    return {
      specificationVersion: 'v3',
      provider: this.name,
      modelId,
      doGenerate: async ({
        text,
        voice,
        outputFormat,
        speed,
        instructions,
        language,
        providerOptions,
        ...options
      }) => {
        const extra = speechOptions.parse(providerOptions?.xinference ?? {});
        const format = z
          .enum(['mp3', 'wav', 'flac', 'opus', 'aac', 'pcm'])
          .parse(outputFormat ?? 'wav');
        const rate = z
          .number()
          .min(0.25)
          .max(4)
          .parse(speed ?? 1);
        const payload = {
          model: modelId,
          input: text,
          voice: voice ?? '',
          speed: rate,
          response_format: format,
          stream: false,
          kwargs: JSON.stringify({
            ...(instructions && isVoxCPM
              ? { control_instruction: instructions }
              : {}),
            ...extra.kwargs,
          }),
        };
        let body: string | Buffer = JSON.stringify(payload);
        let contentType = 'application/json';
        if (extra.promptSpeech) {
          const form = new FormData();
          for (const [key, value] of Object.entries(payload))
            form.set(key, String(value));
          const bytes = Buffer.from(extra.promptSpeech, 'base64');
          const extension = {
            'audio/wav': 'wav',
            'audio/mpeg': 'mp3',
            'audio/flac': 'flac',
            'audio/ogg': 'ogg',
          }[extra.promptSpeechMediaType];
          form.set(
            'prompt_speech',
            new Blob([bytes], { type: extra.promptSpeechMediaType }),
            `reference.${extension}`,
          );
          // Xinference parses multipart only when a reference file is present.
          const encoded = new Request(this.baseUrl, {
            method: 'POST',
            body: form,
          });
          body = Buffer.from(await encoded.arrayBuffer());
          contentType = encoded.headers.get('content-type')!;
        }
        const response = await this.requestResource('audio/speech', {
          ...options,
          body,
          contentType,
          maxBytes: 50_000_000,
          timeoutMs: extra.timeoutMs ?? 300_000,
        });
        const responseType = response.headers['content-type']
          ?.split(';')[0]
          ?.trim();
        if (
          !response.body.length ||
          !responseType ||
          !(
            responseType.startsWith('audio/') ||
            responseType === 'application/octet-stream'
          )
        )
          throw new Error('Invalid Xinference audio response');
        return {
          audio: response.body,
          warnings: [
            ...(instructions && !isVoxCPM
              ? [
                  {
                    type: 'unsupported' as const,
                    feature: 'instructions',
                    details:
                      'Use model-specific providerOptions.xinference.kwargs instead.',
                  },
                ]
              : []),
            ...(rate !== 1 && isVoxCPM
              ? [
                  {
                    type: 'unsupported' as const,
                    feature: 'speed',
                    details:
                      'VoxCPM ignores speed; audio uses the model default pace.',
                  },
                ]
              : []),
            ...(language
              ? [
                  {
                    type: 'unsupported' as const,
                    feature: 'language',
                    details:
                      'Use model-specific providerOptions.xinference.kwargs instead.',
                  },
                ]
              : []),
          ],
          response: {
            timestamp: new Date(),
            modelId,
            headers: response.headers,
          },
        };
      },
    };
  }

  private assertModelId(modelId: string) {
    if (!modelId.trim()) throw new Error('Xinference model ID is required');
  }

  private async requestResource(
    path: string,
    options: {
      body?: WebRequestOptions['body'];
      abortSignal?: AbortSignal;
      headers?: Record<string, string | undefined>;
      contentType?: string;
      maxBytes?: number;
      timeoutMs?: number;
    } = {},
  ) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(
        this.provider.timeoutMs ?? options.timeoutMs ?? 60_000,
      ),
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    signal.throwIfAborted();
    const headers = new Headers();
    for (const [key, value] of Object.entries(options.headers ?? {}))
      if (value !== undefined) headers.set(key, value);
    if (this.provider.apiKey)
      headers.set('authorization', `Bearer ${this.provider.apiKey}`);
    else headers.delete('authorization');
    headers.set('content-type', options.contentType ?? 'application/json');
    const response = await this.request(`${this.baseUrl}/${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      signal,
      headers: Object.fromEntries(headers),
      body: options.body,
      maxBytes: options.maxBytes ?? 20_000_000,
    });
    signal.throwIfAborted();
    if (response.status !== 200)
      throw new Error(`Xinference request failed (${response.status})`);
    return response;
  }

  private async requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    options: Parameters<XinferenceProvider['requestResource']>[1] = {},
  ) {
    const response = await this.requestResource(path, options);
    let raw: unknown;
    try {
      raw = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new Error('Invalid Xinference JSON response');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid Xinference response');
    return {
      data: parsed.data,
      response: { headers: response.headers, body: raw },
    };
  }
}
