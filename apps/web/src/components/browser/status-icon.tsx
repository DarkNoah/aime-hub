import { useContext } from 'react';
import { Globe2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RunningBrowsersContext } from './layout-context';

/** Reuse the dock's running-browser catalog without starting a screencast. */
export function BrowserStatusIcon({ threadId }: { threadId?: string }) {
  const { t } = useTranslation();
  const browsers = useContext(RunningBrowsersContext);
  const running =
    !!threadId && browsers.some((browser) => browser.threadId === threadId);
  return (
    <span className="relative inline-flex size-4 shrink-0">
      <Globe2 className="size-4" aria-hidden />
      {running && (
        <span
          role="img"
          aria-label={t('browser.status.ready')}
          title={t('browser.status.ready')}
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-emerald-500 ring-2 ring-background"
        />
      )}
    </span>
  );
}
