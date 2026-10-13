import type { DataSource } from 'typeorm';
import { ProviderModel, Setting, Project } from '@aime/db';
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
import type { ModelDefaults } from '@aime/shared/providers';
import { modelSupportsType } from '@aime/shared/providers';
import type { ProviderService } from '../providers/service.js';
import { ProviderError } from '../providers/network.js';
import { ThreadError } from '../threads/errors.js';
import type { AgentService } from '../agents/service.js';

export function getProviderOptions({
  reasoningEffort,
  reasoning = true,
  thinkingMode = 'medium',
}: {
  reasoningEffort: ReasoningEffort;
  reasoning?: boolean;
  thinkingMode?: ModelDefaults['thinkingMode'];
}): SharedProviderOptions {
  if (!reasoning) return {};
  const effort = reasoningEffort === 'auto' ? thinkingMode : reasoningEffort;
  return {
    openai: { reasoningEffort: effort, store: false },
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
  maxContextTokens?: number;
};

export class LanguageModelService {
  constructor(
    private database: DataSource,
    private providers: ProviderService,
    private agents?: Pick<AgentService, 'getConfig'>,
  ) {}

  async getPreferences(userId: string): Promise<ChatSettings> {
    const setting = await this.database.manager.findOneBy(Setting, {
      id: `chat:user:${userId}`,
    });
    return chatSettingsSchema.parse(setting?.value ?? {});
  }

  async setPreferences(userId: string, input: ChatSettings) {
    const agent = await this.agents?.getConfig(input.agentId);
    const model = agent?.model ?? input.model;
    if (model) await this.getLanguageModel(userId, { ...input, model });
    await this.database.manager.save(Setting, {
      id: `chat:user:${userId}`,
      value: input,
    });
    return input;
  }

  async getLanguageModel(
    userId: string,
    input: ChatSettings,
    projectId?: string,
  ): Promise<ResolvedChatModel> {
    const [preferences, defaults] = await Promise.all([
      projectId
        ? this.getProjectPreferences(projectId)
        : this.getPreferences(userId),
      this.providers.getDefaults(),
    ]);
    const reference = input.model ?? preferences.model ?? defaults.defaultModel;
    if (!reference) throw new ThreadError('MODEL_NOT_CONFIGURED');
    const slash = reference.indexOf('/');
    if (slash < 1) throw new ThreadError('MODEL_UNAVAILABLE');
    const providerId = reference.slice(0, slash);
    const modelId = reference.slice(slash + 1);
    const [provider, model] = await Promise.all([
      this.providers.getProviderInstance(providerId).catch((error: unknown) => {
        if (
          error instanceof ProviderError &&
          ['NOT_FOUND', 'INVALID_MODEL', 'PROVIDER_CONFIG_ONLY'].includes(
            error.code,
          )
        )
          throw new ThreadError('MODEL_UNAVAILABLE');
        throw error;
      }),
      this.database.manager.findOneBy(ProviderModel, {
        providerId,
        id: modelId,
        enabled: true,
      }),
    ]);
    if (!model || !modelSupportsType(model, 'language'))
      throw new ThreadError('MODEL_UNAVAILABLE');
    return {
      reference,
      model: provider.languageModel(modelId),
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
      maxContextTokens: model.limitContext ?? undefined,
    };
  }

  private async getProjectPreferences(
    projectId: string,
  ): Promise<ChatSettings> {
    const project = await this.database.manager.findOneBy(Project, {
      id: projectId,
    });
    if (!project) throw new ThreadError('PROJECT_NOT_FOUND', 404);
    return chatSettingsSchema.parse(project.metadata.chat ?? {});
  }
}
