import { useState } from 'react';
import { useLocation, useNavigate, useMatch } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, MessageSquare, Plus } from 'lucide-react';
import type { ThreadSummary } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useThreadList } from '../use-thread-list';
import { ThreadList } from './thread-list';
import { ThreadDialog } from './thread-dialogs';

export function ThreadSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const selectedId = useMatch('/threads/:threadId')?.params.threadId;
  const { updateThread, removeThread } = useThreadList();
  const [open, setOpen] = useState(true);
  const [action, setAction] = useState<{
    thread: ThreadSummary;
    mode: 'rename' | 'delete';
  } | null>(null);
  const select = (id?: string) => {
    navigate(id ? `/threads/${id}` : '/threads');
    onNavigate?.();
  };
  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            'flex h-10 items-center rounded-lg',
            location.pathname.startsWith('/threads') &&
              'bg-card text-primary ring-1 ring-border',
          )}
        >
          <CollapsibleTrigger className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-sm outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring">
            <MessageSquare className="size-4 shrink-0" />
            <span className="font-medium">{t('nav.chats')}</span>
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'ml-auto size-3.5 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )}
            />
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0"
            aria-label={t('chat.new')}
            onClick={() => select()}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <CollapsibleContent>
          <div className="mt-1 mb-2 ml-5 border-l pl-2">
            <ThreadList
              selectedId={selectedId}
              onSelect={select}
              onAction={(thread, mode) => setAction({ thread, mode })}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {action && (
        <ThreadDialog
          key={`${action.thread.id}:${action.mode}`}
          {...action}
          onClose={() => setAction(null)}
          onSaved={updateThread}
          onDeleted={() => {
            removeThread(action.thread.id);
            if (selectedId === action.thread.id) select();
          }}
        />
      )}
    </>
  );
}
