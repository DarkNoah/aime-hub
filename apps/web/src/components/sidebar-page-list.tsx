import type { CSSProperties, ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { chatErrorKey } from '@/components/chat/api';

// Fetch only in response to a scroll or an explicit click. An intersection
// observer would eagerly drain small pages while this section is expanded.
export function SidebarPageList({
  children,
  label,
  loading,
  error,
  hasMore,
  loadMore,
  moreLabel,
  maxHeight = '11.25rem',
}: {
  children: ReactNode;
  label: string;
  loading: boolean;
  error: ReturnType<typeof chatErrorKey> | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  moreLabel: string;
  maxHeight?: CSSProperties['maxHeight'];
}) {
  const { t } = useTranslation();
  return (
    <ScrollArea
      className="overflow-hidden rounded-md"
      viewportProps={{
        role: 'navigation',
        'aria-label': label,
        tabIndex: 0,
        className: 'overscroll-contain [&>div]:block!',
        style: { maxHeight },
        onScroll: (event) => {
          if (
            event.target !== event.currentTarget ||
            loading ||
            error ||
            !hasMore
          )
            return;
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          if (scrollTop > 0 && scrollHeight - clientHeight - scrollTop < 24)
            void loadMore();
        },
      }}
    >
      {children}
      {error ? (
        <div role="alert" className="space-y-2 px-2 py-2 text-xs">
          <p>{t(error)}</p>
          <Button size="sm" variant="outline" onClick={() => void loadMore()}>
            {t('providers.retry')}
          </Button>
        </div>
      ) : loading ? (
        <div
          role="status"
          aria-label={t('common.loading')}
          className="flex h-8 items-center justify-center"
        >
          <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full text-xs text-muted-foreground"
            onClick={() => void loadMore()}
          >
            {moreLabel}
          </Button>
        )
      )}
    </ScrollArea>
  );
}
