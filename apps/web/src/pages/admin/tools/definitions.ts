import type { ToolId } from '@aime/shared/tools';
import type { TranslationKey } from '@/i18n/config';

type ToolDefinition = {
  title: TranslationKey;
  description: TranslationKey;
  configure: TranslationKey;
  enable: TranslationKey;
  provider: TranslationKey;
  providerHint: TranslationKey;
  invalidProvider: TranslationKey;
  missingProvider: TranslationKey;
  fallbackHint: TranslationKey;
  localLabel: TranslationKey;
  providerType: 'serpapi' | 'jina-ai';
  localId: string;
};

export const toolDefinitions: Record<ToolId, ToolDefinition> = {
  web_search: {
    title: 'tools.webSearch',
    description: 'tools.searchDescription',
    configure: 'tools.configure',
    enable: 'tools.enable',
    provider: 'tools.provider',
    providerHint: 'tools.providerHint',
    invalidProvider: 'tools.invalidProvider',
    missingProvider: 'tools.missingProvider',
    fallbackHint: 'tools.fallbackHint',
    localLabel: 'tools.sogou',
    providerType: 'serpapi',
    localId: 'sogou',
  },
  web_fetch: {
    title: 'tools.webFetch',
    description: 'tools.fetchDescription',
    configure: 'tools.configureFetch',
    enable: 'tools.enableFetch',
    provider: 'tools.fetchProvider',
    providerHint: 'tools.fetchProviderHint',
    invalidProvider: 'tools.invalidFetchProvider',
    missingProvider: 'tools.missingFetchProvider',
    fallbackHint: 'tools.fetchFallbackHint',
    localLabel: 'tools.localFetch',
    providerType: 'jina-ai',
    localId: 'local',
  },
};
