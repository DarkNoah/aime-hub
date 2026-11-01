import {
  PROVIDER_REGISTRY,
  type OpenAICompatibleConfig,
} from '@mastra/core/llm';
import {
  parseProviderMetadata,
  type ProviderConfiguration,
} from '@aime/shared/provider-configuration';
import type { ProviderConfig, ProviderModelInfo } from './base-provider.js';
import type { SpeechModelSettings } from './speech-model.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { requestProviderJson } from '../../modules/providers/network.js';
import { requestWebResource } from '../web/request.js';
import {
  ALIBABA_3D_MODELS,
  ALIBABA_SPEECH_MODELS,
  ALIBABA_TRANSCRIPTION_MODELS,
} from './alibaba/catalog.js';
import { AlibabaSpeechModel } from './alibaba/speech.js';
import { AlibabaTranscriptionModel } from './alibaba/transcription.js';
import { Alibaba3DModel } from './alibaba/model3d.js';

export class AlibabaProvider extends OpenAICompatibleProvider {
  static override readonly configuration: ProviderConfiguration = {
    fields: [
      {
        key: 'workspaceId',
        type: 'text',
        label: {
          en: 'Model Studio Workspace ID',
          'zh-CN': '百炼 Workspace ID',
        },
        description: {
          en: 'Set a Workspace ID and the region matching your API key before using speech, transcription or 3D. 3D is available in Beijing only.',
          'zh-CN':
            '使用语音、转录或 3D 能力前，请填写 Workspace ID，并选择与 API Key 一致的地域。3D 仅支持北京。',
        },
        pattern: '^[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?$',
      },
      {
        key: 'region',
        type: 'select',
        label: {
          en: 'Region',
          'zh-CN': '地域',
        },
        defaultValue: 'cn-beijing',
        options: [
          {
            value: 'cn-beijing',
            label: 'cn-beijing',
          },
          {
            value: 'ap-southeast-1',
            label: 'ap-southeast-1',
          },
          {
            value: 'ap-northeast-1',
            label: 'ap-northeast-1',
          },
          {
            value: 'eu-central-1',
            label: 'eu-central-1',
          },
          {
            value: 'us-east-1',
            label: 'us-east-1',
          },
          {
            value: 'cn-hongkong',
            label: 'cn-hongkong',
          },
        ],
      },
    ],
    description: {
      en: 'Chat uses the compatible API; speech, transcription and 3D use native Model Studio APIs.',
      'zh-CN': '聊天使用兼容接口；语音、转录和 3D 使用百炼原生接口。',
    },
    baseUrlHint: {
      en: 'Enter the compatible chat API URL. Speech, transcription and 3D endpoints use the Workspace ID and region.',
      'zh-CN':
        '填写聊天兼容接口地址。语音、转录和 3D 接口由 Workspace ID 与地域确定。',
    },
  };

  static override getConfiguration(type: string): ProviderConfiguration {
    return {
      ...this.configuration,
      defaultBaseUrl: `https://${type === 'alibaba' ? 'dashscope-intl' : 'dashscope'}.aliyuncs.com/compatible-mode/v1`,
    };
  }

  constructor(
    provider: ProviderConfig & { type: string },
    requestJson = requestProviderJson,
    private readonly mediaRequest = requestWebResource,
  ) {
    super(provider, requestJson, mediaRequest);
  }

  private settings() {
    const values = parseProviderMetadata(
      AlibabaProvider.configuration.fields,
      this.provider.metadata ?? {},
    );
    return {
      workspaceId:
        typeof values.workspaceId === 'string' ? values.workspaceId : undefined,
      region: String(values.region),
    };
  }

  private nativeOptions(modelId: string) {
    const { workspaceId, region } = this.settings();
    if (!workspaceId)
      throw new Error('Set an Alibaba Workspace ID in provider settings');
    return {
      modelId,
      region,
      apiKey: this.provider.apiKey ?? '',
      apiBase: `https://${workspaceId}.${region}.maas.aliyuncs.com/api/v1`,
      request: this.mediaRequest,
    };
  }

  override languageModel(modelId: string): OpenAICompatibleConfig {
    return {
      providerId: 'openai',
      modelId,
      url: this.provider.baseUrl,
      apiKey: this.provider.apiKey ?? '',
      api: 'chat',
    };
  }

  override async getLanguageModelList(): Promise<ProviderModelInfo[]> {
    // Model Studio does not expose a complete media catalog via /models.
    const catalog = PROVIDER_REGISTRY[this.type as 'alibaba' | 'alibaba-cn'];
    return catalog.models.map((id) => ({ id, name: id }));
  }

  override async getSpeechModelList(): Promise<ProviderModelInfo[]> {
    const { region } = this.settings();
    return ALIBABA_SPEECH_MODELS.filter((model) =>
      model.regions.includes(region),
    ).map(({ id, name, defaultVoice }) => ({
      id,
      name,
      modelType: 'speech',
      modalitiesInput: ['text'],
      modalitiesOutput: ['audio'],
      ...(defaultVoice
        ? { metadata: { speechDefaultVoice: defaultVoice } }
        : {}),
    }));
  }

  override async getTranscriptionModelList(): Promise<ProviderModelInfo[]> {
    const { region } = this.settings();
    return ALIBABA_TRANSCRIPTION_MODELS.filter((model) =>
      model.regions.includes(region),
    ).map(({ id, name }) => ({
      id,
      name,
      modelType: 'asr',
      modalitiesInput: ['audio'],
      modalitiesOutput: ['text'],
    }));
  }

  override async get3DModelList(): Promise<ProviderModelInfo[]> {
    return this.settings().region === 'cn-beijing'
      ? ALIBABA_3D_MODELS.map((model) => ({
          ...model,
          modelType: 'model3d',
          modalitiesInput: ['text', 'image'],
          modalitiesOutput: ['model3d'],
        }))
      : [];
  }

  override async getModelList(): Promise<ProviderModelInfo[]> {
    const lists = await Promise.all([
      this.getLanguageModelList(),
      this.getSpeechModelList(),
      this.getTranscriptionModelList(),
      this.get3DModelList(),
    ]);
    // Native declarations win when a media model also appears in the chat catalog.
    const allMediaIds = new Set(
      [
        ...ALIBABA_SPEECH_MODELS,
        ...ALIBABA_TRANSCRIPTION_MODELS,
        ...ALIBABA_3D_MODELS,
      ].map(({ id }) => id),
    );
    return [
      ...lists[0].filter(({ id }) => !allMediaIds.has(id)),
      ...lists.slice(1).flat(),
    ];
  }

  override speechModel(modelId: string, settings?: SpeechModelSettings) {
    return new AlibabaSpeechModel({
      ...this.nativeOptions(modelId),
      defaultVoice:
        typeof settings?.metadata?.speechDefaultVoice === 'string'
          ? settings.metadata.speechDefaultVoice
          : undefined,
    });
  }

  override transcriptionModel(modelId: string) {
    return new AlibabaTranscriptionModel(this.nativeOptions(modelId));
  }

  override model3d(modelId: string) {
    return new Alibaba3DModel(this.nativeOptions(modelId));
  }
}
