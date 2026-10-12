import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import { z } from 'zod';
import { requestProviderJson } from '../../modules/providers/network.js';
import { createImageModel } from './image-model.js';
import {
  BaseProvider,
  type ProviderConfig,
  type ProviderModelInfo,
} from './base-provider.js';

const modelListResponse = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(256) })).max(10000),
});

export class OpenAICompatibleProvider extends BaseProvider {
  readonly name: string;
  readonly type: string;

  constructor(
    provider: ProviderConfig & { type: string },
    private readonly request = requestProviderJson,
  ) {
    super({ provider });
    this.name = provider.type;
    this.type = provider.type;
  }

  languageModel(modelId: string): OpenAICompatibleConfig {
    return {
      providerId: 'openai',
      modelId,
      url: this.provider.baseUrl,
      apiKey: this.provider.apiKey ?? '',
      api: 'chat',
    };
  }

  imageModel(modelId: string) {
    return createImageModel(this.provider, modelId);
  }

  async getLanguageModelList(): Promise<ProviderModelInfo[]> {
    const response = modelListResponse.parse(
      await this.request(
        `${this.provider.baseUrl.replace(/\/+$/, '')}/models`,
        this.provider.apiKey ?? undefined,
      ),
    );
    return response.data.map(({ id }) => ({ id, name: id }));
  }
}
