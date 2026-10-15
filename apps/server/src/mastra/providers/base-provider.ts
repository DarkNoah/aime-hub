import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type {
  EmbeddingModel,
  ImageModel,
  LanguageModel,
  RerankingModel,
  SpeechModel,
} from 'ai';
import type { ModelInput } from '@aime/shared/providers';
import { z } from 'zod';
import type { OcrModel } from './ocr-model.js';
export type { OcrModel, OcrInput, OcrOptions, OcrResult } from './ocr-model.js';

export type WebFetchResult = {
  content: string;
  url: string;
  title?: string;
  contentType?: string;
};
export type WebFetchOptions = { abortSignal?: AbortSignal };

export const searchResultSchema = z.object({
  title: z.string(),
  href: z.string(),
  snippet: z.string().optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
export type WebSearchInput = { query: string; numResults: number };
export type WebSearchOptions = { abortSignal?: AbortSignal };

export type ProviderConfig = {
  id: string;
  baseUrl: string;
  apiKey?: string | null;
  timeoutMs?: number;
};

export type ProviderModelInfo = { id: string; name: string } & Partial<
  Pick<
    ModelInput,
    'modelType' | 'modalitiesInput' | 'modalitiesOutput' | 'limitContext'
  >
>;

export interface BaseProviderParams {
  provider: ProviderConfig;
}

export abstract class BaseProvider {
  readonly id: string;
  readonly provider: ProviderConfig;
  abstract name: string;
  abstract type: string;

  constructor({ provider }: BaseProviderParams) {
    this.provider = provider;
    this.id = provider.id;
  }

  languageModel(modelId: string): LanguageModel | OpenAICompatibleConfig {
    throw new Error(`Language model is not supported: ${this.type}/${modelId}`);
  }

  textEmbeddingModel(modelId: string): EmbeddingModel {
    throw new Error(
      `Embedding model is not supported: ${this.type}/${modelId}`,
    );
  }

  rerankModel(modelId: string): RerankingModel {
    throw new Error(`Rerank model is not supported: ${this.type}/${modelId}`);
  }

  embeddingModel(modelId: string): EmbeddingModel {
    return this.textEmbeddingModel(modelId);
  }

  rerankingModel(modelId: string): RerankingModel {
    return this.rerankModel(modelId);
  }

  speechModel(modelId: string, options?: { modelName?: string }): SpeechModel {
    void options;
    throw new Error(`Speech model is not supported: ${this.type}/${modelId}`);
  }

  imageModel(modelId: string): ImageModel {
    throw new Error(`Image model is not supported: ${this.type}/${modelId}`);
  }

  ocrModel(modelId: string): OcrModel {
    throw new Error(`OCR model is not supported: ${this.type}/${modelId}`);
  }

  getLanguageModelList(): Promise<ProviderModelInfo[]> {
    return Promise.resolve([]);
  }

  getModelList(): Promise<ProviderModelInfo[]> {
    return this.getLanguageModelList();
  }

  getSpeechModelList(): Promise<ProviderModelInfo[]> {
    return Promise.resolve([]);
  }

  getEmbeddingModelList(): Promise<ProviderModelInfo[]> {
    return Promise.resolve([]);
  }

  getRerankModelList(): Promise<ProviderModelInfo[]> {
    return Promise.resolve([]);
  }

  getOcrModelList(): Promise<ProviderModelInfo[]> {
    return Promise.resolve([]);
  }

  async webFetch(
    url: string,
    options?: WebFetchOptions,
  ): Promise<WebFetchResult> {
    void url;
    void options;
    throw new Error(`Web fetch is not supported: ${this.type}`);
  }

  async webSearch(
    input: WebSearchInput,
    options?: WebSearchOptions,
  ): Promise<SearchResult[]> {
    void input;
    void options;
    throw new Error(`Web search is not supported: ${this.type}`);
  }
}
