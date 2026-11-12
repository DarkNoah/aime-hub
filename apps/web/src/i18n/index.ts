import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { i18nOptions, resolveLocale, type Locale } from './config';

export const i18n = createInstance();
export type LanguagePreference = Locale | 'system';

const LANGUAGE_STORAGE_KEY = 'ui-language';
let languagePreference: LanguagePreference = 'system';
const preferenceListeners = new Set<() => void>();

function parsePreference(value: string | null): LanguagePreference {
  return value === 'zh-CN' || value === 'en' ? value : 'system';
}

function storedPreference(): LanguagePreference {
  try {
    return parsePreference(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function getLanguagePreference() {
  return languagePreference;
}

export function subscribeLanguagePreference(onChange: () => void) {
  preferenceListeners.add(onChange);
  return () => {
    preferenceListeners.delete(onChange);
  };
}

const browserLocale = () =>
  resolveLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );

function updateDocument() {
  document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
  document.title = i18n.t('meta.title');
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute('content', i18n.t('meta.description'));
}

async function applyPreference(preference: LanguagePreference) {
  languagePreference = preference;
  await i18n.changeLanguage(
    preference === 'system' ? browserLocale() : preference,
  );
  preferenceListeners.forEach((listener) => listener());
}

export async function setLanguagePreference(preference: LanguagePreference) {
  let saved = true;
  try {
    if (preference === 'system') localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // Switching still works for this page when browser storage is unavailable.
    saved = false;
  }
  await applyPreference(preference);
  return saved;
}

function onLanguageChange() {
  if (languagePreference === 'system') {
    void i18n.changeLanguage(browserLocale());
  }
}

function onStorageChange(event: StorageEvent) {
  if (
    (event.key === LANGUAGE_STORAGE_KEY || event.key === null) &&
    event.storageArea === window.localStorage
  ) {
    void applyPreference(parsePreference(event.newValue));
  }
}

export async function initializeI18n() {
  languagePreference = storedPreference();
  await i18n.use(initReactI18next).init({
    ...i18nOptions,
    lng: languagePreference === 'system' ? browserLocale() : languagePreference,
  });
  updateDocument();
  i18n.on('languageChanged', updateDocument);
  window.addEventListener('languagechange', onLanguageChange);
  window.addEventListener('storage', onStorageChange);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    i18n.off('languageChanged', updateDocument);
    window.removeEventListener('languagechange', onLanguageChange);
    window.removeEventListener('storage', onStorageChange);
  });
}
