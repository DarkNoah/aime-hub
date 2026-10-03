import { isThreadActive } from '@aime/shared/threads';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThreadSummary } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { ThreadActivityTitle, ThreadStatusBadge } from './thread-activity';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export function ThreadListItems({
  threads,
  selectedId,
  onSelect,
  onAction,
  canManage,
}: {
  threads: ThreadSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onAction: (thread: ThreadSummary, mode: 'rename' | 'delete') => void;
  canManage?: (thread: ThreadSummary) => boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {threads.map((thread) => (
        <div
          key={thread.id}
          className={cn(
            'group/thread flex h-9 w-full min-w-0 items-center rounded-md transition-colors',
            thread.id === selectedId &&
              'bg-card text-primary ring-1 ring-border',
          )}
        >
          <button
            type="button"
            aria-current={thread.id === selectedId ? 'page' : undefined}
            title={thread.title || t('chat.new')}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelect(thread.id)}
          >
            {isThreadActive(thread.status) && (
              <ThreadStatusBadge
                status={thread.status}
                className="shrink-0 px-1 py-0 text-[10px]"
              />
            )}
            <ThreadActivityTitle
              active={isThreadActive(thread.status)}
              className="text-[13px]"
            >
              {thread.title || t('chat.new')}
            </ThreadActivityTitle>
            {thread.status !== 'idle' &&
              thread.status !== 'success' &&
              thread.status !== 'canceled' &&
              !isThreadActive(thread.status) && (
                <ThreadStatusBadge
                  status={thread.status}
                  className="shrink-0 px-1 py-0 text-[10px]"
                />
              )}
          </button>
          {(!canManage || canManage(thread)) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground transition-opacity group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0"
                  aria-label={t('chat.actions', {
                    title: thread.title || t('chat.new'),
                  })}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onAction(thread, 'rename')}>
                  {t('chat.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  disabled={
                    isThreadActive(thread.status) ||
                    thread.stopping ||
                    !!thread.queue.length
                  }
                  onSelect={() => onAction(thread, 'delete')}
                >
                  {t('chat.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}
    </>
  );
}
