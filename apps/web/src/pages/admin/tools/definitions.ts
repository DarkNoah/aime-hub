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
  localId: string;
};

export const toolDefinitions = {
  view_file: {
    title: 'tools.viewFile',
    description: 'tools.viewFileDescription',
    configure: 'tools.configureViewFile',
  },
  image_gen: {
    title: 'tools.imageGen',
    description: 'tools.imageDescription',
    configure: 'tools.configureImage',
  },
  transcribe: {
    title: 'tools.transcribe',
    description: 'tools.transcribeDescription',
    configure: 'tools.configureTranscribe',
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
    localLabel: 'tools.sogou',
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
    localId: 'local',
  },
} satisfies Record<
  Exclude<
    ConfigurableToolId,
    'image_gen' | 'speech' | 'transcribe' | 'view_file'
  >,
  ToolDefinition
> &
  Record<
    'image_gen' | 'speech' | 'transcribe' | 'view_file',
    Pick<ToolDefinition, 'title' | 'description' | 'configure'>
  >;
