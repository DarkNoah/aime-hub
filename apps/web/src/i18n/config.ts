import type { InitOptions } from 'i18next';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';

export type Locale = 'zh-CN' | 'en';
export type TranslationKey = keyof typeof en;
export type ErrorKey = Extract<TranslationKey, `errors.${string}`>;

// Respect the browser's preference order; Chinese variants currently use Simplified Chinese.
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.trim().toLowerCase().split(/[-_]/)[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export const i18nOptions = {
  resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } },
  supportedLngs: ['zh-CN', 'en'],
  fallbackLng: 'en',
  keySeparator: false,
  returnNull: false,
  interpolation: { escapeValue: false }, // React escapes rendered text.
} satisfies InitOptions;

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
    keySeparator: false;
    returnNull: false;
    strictKeyChecks: true;
  }
}
