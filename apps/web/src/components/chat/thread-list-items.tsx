import { isThreadActive } from '@aime/shared/threads';
import { Clock3, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ThreadSummary } from '@aime/shared/threads';
import { Item, ItemActions, ItemGroup } from '@/components/ui/item';
import { ThreadActivityTitle, ThreadStatusIcon } from './thread-activity';
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
    <ItemGroup>
      {threads.map((thread) => (
        <Item
          key={thread.id}
          role="listitem"
          className={cn(
            'h-8 w-full min-w-0 flex-nowrap gap-0 p-0 hover:bg-card/60 mb-1',
            thread.id === selectedId && 'bg-card text-primary ',
          )}
        >
          <Item
            asChild
            className="min-w-0 flex-1 flex-nowrap gap-1.5 border-0 px-3 py-0 text-left font-normal"
          >
            <button
              type="button"
              className={cn(thread.id === selectedId && 'font-bold!')}
              aria-current={thread.id === selectedId ? 'page' : undefined}
              title={thread.title || t('chat.new')}
              onClick={() => onSelect(thread.id)}
            >
              {thread.status !== 'idle' && thread.status !== 'success' && (
                <ThreadStatusIcon status={thread.status} />
              )}
              {thread.id.startsWith('schedule:') && (
                <span
                  className="inline-flex shrink-0 text-muted-foreground"
                  role="img"
                  aria-label={t('automations.threadLabel')}
                  title={t('automations.threadLabel')}
                >
                  <Clock3 className="size-3.5" aria-hidden="true" />
                </span>
              )}
              <ThreadActivityTitle
                active={isThreadActive(thread.status)}
                className="text-[13px]"
              >
                {thread.title || t('chat.new')}
              </ThreadActivityTitle>
            </button>
          </Item>
          {(!canManage || canManage(thread)) && (
            <ItemActions className="shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover/item:opacity-100 group-focus-within/item:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0"
                  aria-label={t('chat.actions', {
                    title: thread.title || t('chat.new'),
                  })}
                >
                  <MoreHorizontal className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onAction(thread, 'rename')}>
                    {t('chat.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={
                      thread.projectId ? 'text-destructive' : undefined
                    }
                    disabled={
                      isThreadActive(thread.status) || thread.queueCount > 0
                    }
                    onSelect={() => onAction(thread, 'delete')}
                  >
                    {t(thread.projectId ? 'chat.delete' : 'chat.archive')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ItemActions>
          )}
        </Item>
      ))}
    </ItemGroup>
  );
}
