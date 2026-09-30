import type { DataSource } from 'typeorm';
import { Provider, ProviderModel, Setting } from '@aime/db';
import {
  chatSettingsSchema,
  type ChatSettings,
  type ReasoningEffort,
} from '@aime/shared/threads';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { AgentExecutionOptions } from '@mastra/core/agent';
type SharedProviderOptions = NonNullable<
  AgentExecutionOptions<undefined>['providerOptions']
>;
import type { ProviderService } from '../providers/service.js';
import { ThreadError } from '../threads/errors.js';

export function getProviderOptions({
  reasoningEffort,
  reasoning = true,
  thinkingMode = 'auto',
}: {
  reasoningEffort: ReasoningEffort;
  reasoning?: boolean;
  thinkingMode?: 'auto' | 'on' | 'off';
}): SharedProviderOptions {
  if (!reasoning) return {};
  const effort =
    reasoningEffort === 'auto'
      ? thinkingMode === 'off'
        ? 'none'
        : thinkingMode === 'on'
          ? 'medium'
          : null
      : reasoningEffort;
  if (!effort) return {};
  return {
    openai: { reasoningEffort: effort },
    deepseek: {
      thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
      ...(effort === 'none'
        ? {}
        : { reasoningEffort: effort === 'minimal' ? 'low' : effort }),
    },
  };
}

export type ResolvedChatModel = {
  reference: string;
  model: OpenAICompatibleConfig;
  providerOptions: SharedProviderOptions;
  supportsImages: boolean;
  toolCall: boolean;
  maxOutputTokens?: number;
};

export class LanguageModelService {
  constructor(
    private database: DataSource,
    private providers: ProviderService,
  ) {}

  async getPreferences(userId: string): Promise<ChatSettings> {
    const setting = await this.database.manager.findOneBy(Setting, {
      id: `chat:user:${userId}`,
    });
    return chatSettingsSchema.parse(setting?.value ?? {});
  }

  async setPreferences(userId: string, input: ChatSettings) {
    if (input.model) await this.getLanguageModel(userId, input);
    await this.database.manager.save(Setting, {
      id: `chat:user:${userId}`,
      value: input,
    });
    return input;
  }

  async getLanguageModel(
    userId: string,
    input: ChatSettings,
  ): Promise<ResolvedChatModel> {
    const [preferences, defaults] = await Promise.all([
      this.getPreferences(userId),
      this.providers.getDefaults(),
    ]);
    const reference = input.model ?? preferences.model ?? defaults.defaultModel;
    if (!reference) throw new ThreadError('MODEL_NOT_CONFIGURED');
    const slash = reference.indexOf('/');
    if (slash < 1) throw new ThreadError('MODEL_UNAVAILABLE');
    const providerId = reference.slice(0, slash);
    const modelId = reference.slice(slash + 1);
    const [provider, model] = await Promise.all([
      this.database
        .getRepository(Provider)
        .createQueryBuilder('provider')
        .addSelect('provider.apiKey')
        .where('provider.id = :providerId AND provider.enabled = true', {
          providerId,
        })
        .getOne(),
      this.database.manager.findOneBy(ProviderModel, {
        providerId,
        id: modelId,
        enabled: true,
      }),
    ]);
    if (!provider || !model || !model.modalitiesOutput.includes('text'))
      throw new ThreadError('MODEL_UNAVAILABLE');
    return {
      reference,
      // Separate fields preserve model IDs containing slashes. Connections are server-only.
      model: {
        providerId: 'openai',
        modelId,
        url: provider.baseUrl,
        apiKey: provider.apiKey ?? '',
        api: 'chat',
      },
      providerOptions: getProviderOptions({
        reasoningEffort:
          input.reasoningEffort === 'auto'
            ? preferences.reasoningEffort
            : input.reasoningEffort,
        reasoning: model.reasoning,
        thinkingMode: defaults.thinkingMode,
      }),
      supportsImages: model.modalitiesInput.includes('image'),
      toolCall: model.toolCall,
      maxOutputTokens: model.limitOutput ?? undefined,
    };
  }
}
