import type { ConfigurableToolId } from '@aime/shared/tools';
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
};

export const toolDefinitions = {
  extract: {
    title: 'tools.extract',
    description: 'tools.extractDescription',
    configure: 'tools.configureExtract',
  },
  read_file: {
    title: 'tools.viewFile',
    description: 'tools.viewFileDescription',
    configure: 'tools.configureViewFile',
  },
  image_gen: {
    title: 'tools.imageGen',
    description: 'tools.imageDescription',
    configure: 'tools.configureImage',
  },
  transcriptions: {
    title: 'tools.transcriptions',
    description: 'tools.transcriptionsDescription',
    configure: 'tools.configureTranscriptions',
  },
  speech: {
    title: 'tools.speech',
    description: 'tools.speechDescription',
    configure: 'tools.configureSpeech',
  },
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
    localLabel: 'tools.defaultWebProvider',
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
    localLabel: 'tools.defaultWebProvider',
  },
} satisfies Record<
  Exclude<
    ConfigurableToolId,
    'image_gen' | 'speech' | 'transcriptions' | 'read_file' | 'extract'
  >,
  ToolDefinition
> &
  Record<
    'image_gen' | 'speech' | 'transcriptions' | 'read_file' | 'extract',
    Pick<ToolDefinition, 'title' | 'description' | 'configure'>
  >;
