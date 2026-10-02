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
            'group flex h-9 items-center rounded-md transition-colors hover:bg-accent/60',
            thread.id === selectedId && 'bg-accent text-accent-foreground',
          )}
        >
          <button
            type="button"
            aria-current={thread.id === selectedId ? 'page' : undefined}
            title={thread.title || t('chat.new')}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelect(thread.id)}
          >
            {thread.status === 'running' && (
              <ThreadStatusBadge
                status={thread.status}
                className="shrink-0 px-1 py-0 text-[10px]"
              />
            )}
            <ThreadActivityTitle
              active={thread.status === 'running'}
              className="text-[13px]"
            >
              {thread.title || t('chat.new')}
            </ThreadActivityTitle>
            {thread.status !== 'idle' && thread.status !== 'running' && (
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
                  className="size-7 shrink-0"
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
                    thread.status === 'running' ||
                    thread.status === 'stopping' ||
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
