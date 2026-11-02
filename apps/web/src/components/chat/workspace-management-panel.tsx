import { Suspense, type ReactNode } from 'react';
import { PanelRightClose, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';

export function WorkspaceManagementPanel({
  title,
  icon: Icon,
  onClose,
  children,
}: {
  title: string;
  icon: LucideIcon;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-card"
      aria-label={title}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Icon className="size-4 text-primary" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <PanelRightClose className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <ScrollArea
        className="min-h-0 flex-1"
        viewportProps={{ className: '[&>div]:block!' }}
      >
        <div className="min-w-0 p-4">
          <Suspense
            fallback={
              <div
                role="status"
                aria-label={t('chat.loading')}
                className="space-y-4"
              >
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            }
          >
            {children}
          </Suspense>
        </div>
      </ScrollArea>
    </section>
  );
}
