import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { chatErrorKey } from '@/components/chat/api';

// Sidebar lists grow in the outer navigation's ScrollArea and paginate on click.
// Only standalone pickers opt into a bounded scroll area with maxHeight.
export function SidebarPageList({
  children,
  label,
  loading,
  error,
  hasMore,
  loadMore,
  moreLabel,
  maxHeight,
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
  const content = (
    <div
      role="navigation"
      aria-label={label}
      aria-busy={loading}
      className="min-w-0"
    >
      {children}
      {error ? (
        <div role="alert" className="space-y-2 px-2 py-2 text-xs">
          <p>{t(error)}</p>
          <Button size="sm" variant="outline" onClick={() => void loadMore()}>
            {t('providers.retry')}
          </Button>
        </div>
      ) : (
        (loading || hasMore) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 px-3 text-xs text-muted-foreground"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {loading ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-3.5 animate-spin"
              />
            ) : (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            )}
            <span aria-live="polite">
              {loading ? t('chat.loading') : moreLabel}
            </span>
          </Button>
        )
      )}
    </div>
  );

  if (maxHeight === undefined) return content;

  return (
    <ScrollArea
      className="overflow-hidden rounded-md"
      viewportProps={{
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
      {content}
    </ScrollArea>
  );
}
