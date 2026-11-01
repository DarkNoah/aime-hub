import {
  parseProviderMetadata,
  type ProviderConfigurations,
} from '@aime/shared/provider-configuration';
import { providerTypeSchema } from '@aime/shared/providers';
import { requestProviderJson } from '../../modules/providers/network.js';
import { requestWebResource } from '../web/request.js';
import { BaseProvider, type ProviderConfig } from './base-provider.js';
import { AlibabaProvider } from './alibaba.js';
import { DeepSeekProvider } from './deepseek.js';
import { NewApiProvider } from './newapi.js';
import { XinferenceProvider } from './xinference.js';
import { MinerUProvider } from './mineru.js';
import { PaddleOCRProvider } from './paddleocr.js';
import { SerpApiProvider } from './serpapi.js';
import { JinaAIProvider } from './jina-ai.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

type Config = ProviderConfig & { type: string };
type Dependencies = {
  requestJson: typeof requestProviderJson;
  requestResource: typeof requestWebResource;
};
type Registration = {
  types: readonly string[];
  provider: Pick<typeof BaseProvider, 'getConfiguration'>;
  create: (config: Config, dependencies: Dependencies) => BaseProvider;
};

/** Register an implementation once; discovery, validation and runtime share it. */
const registrations: Registration[] = [
  {
    types: ['alibaba', 'alibaba-cn'],
    provider: AlibabaProvider,
    create: (config, deps) =>
      new AlibabaProvider(config, deps.requestJson, deps.requestResource),
  },
  {
    types: ['deepseek'],
    provider: DeepSeekProvider,
    create: (config, deps) =>
      new DeepSeekProvider(config, deps.requestJson, deps.requestResource),
  },
  {
    types: ['newapi'],
    provider: NewApiProvider,
    create: (config, deps) => new NewApiProvider(config, deps.requestResource),
  },
  {
    types: ['xinference'],
    provider: XinferenceProvider,
    create: (config, deps) =>
      new XinferenceProvider(config, deps.requestResource),
  },
  {
    types: ['mineru'],
    provider: MinerUProvider,
    create: (config, deps) => new MinerUProvider(config, deps.requestResource),
  },
  {
    types: ['paddleocr'],
    provider: PaddleOCRProvider,
    create: (config, deps) =>
      new PaddleOCRProvider(config, deps.requestResource),
  },
  {
    types: ['serpapi'],
    provider: SerpApiProvider,
    create: (config, deps) =>
      new SerpApiProvider(
        {
          ...config,
          apiKey: config.apiKey ?? '',
          timeoutMs: config.timeoutMs ?? 15000,
        },
        deps.requestJson,
      ),
  },
  {
    types: ['jina-ai'],
    provider: JinaAIProvider,
    create: (config, deps) =>
      new JinaAIProvider(
        {
          ...config,
          apiKey: config.apiKey ?? '',
          timeoutMs: config.timeoutMs ?? 15000,
        },
        deps.requestResource,
      ),
  },
];

export function getProviderConfiguration(type: string) {
  return (
    registrations.find((item) => item.types.includes(type))?.provider ??
    OpenAICompatibleProvider
  ).getConfiguration(type);
}

export function getProviderConfigurations(): ProviderConfigurations {
  return Object.fromEntries(
    providerTypeSchema.options.map((type) => [
      type,
      getProviderConfiguration(type),
    ]),
  );
}

export function createProviderInstance(
  config: Config,
  dependencies: Partial<Dependencies> = {},
): BaseProvider {
  config = {
    ...config,
    metadata: parseProviderMetadata(
      getProviderConfiguration(config.type).fields,
      config.metadata ?? {},
    ),
  };
  const deps = {
    requestJson: requestProviderJson,
    requestResource: requestWebResource,
    ...dependencies,
  };
  return (
    registrations
      .find((item) => item.types.includes(config.type))
      ?.create(config, deps) ??
    new OpenAICompatibleProvider(config, deps.requestJson, deps.requestResource)
  );
}
