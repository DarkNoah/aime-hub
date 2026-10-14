import { Suspense } from 'react';
import { PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PluginSidebarProps } from '@app/plugin-sdk/web';
import { Button } from '@/components/ui/button';
import { PluginBoundary } from './boundary';
import type { usePluginRightSidebar } from './use-right-sidebar';

export function PluginRightSidebar({
  entry,
  threadId,
  projectId,
  onClose,
}: Pick<PluginSidebarProps, 'threadId' | 'projectId' | 'onClose'> & {
  entry: ReturnType<typeof usePluginRightSidebar>[number];
}) {
  const { t } = useTranslation();
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-card"
      aria-label={entry.title}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <entry.Icon className="size-4 text-primary" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {entry.title}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <PanelRightClose className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <PluginBoundary key={entry.view} message={t('plugins.sidebarFailed')}>
          <Suspense
            fallback={
              <p role="status" className="p-4 text-sm text-muted-foreground">
                {t('plugins.sidebarLoading')}
              </p>
            }
          >
            <entry.Component
              pluginId={entry.pluginId}
              sidebarId={entry.id}
              threadId={threadId}
              projectId={projectId}
              onClose={onClose}
            />
          </Suspense>
        </PluginBoundary>
      </div>
    </section>
  );
}
