import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { i18nOptions, resolveLocale } from './config';

export const i18n = createInstance();

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

function onLanguageChange() {
  void i18n.changeLanguage(browserLocale());
}

export async function initializeI18n() {
  await i18n
    .use(initReactI18next)
    .init({ ...i18nOptions, lng: browserLocale() });
  updateDocument();
  i18n.on('languageChanged', updateDocument);
  window.addEventListener('languagechange', onLanguageChange);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    i18n.off('languageChanged', updateDocument);
    window.removeEventListener('languagechange', onLanguageChange);
  });
}
