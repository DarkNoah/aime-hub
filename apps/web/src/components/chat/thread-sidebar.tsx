import { useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, LoaderCircle, MessageSquare, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { ThreadSummary } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { chatApi, chatErrorKey } from './api';
import { useThreadListResource } from './use-thread-list';
import { ThreadList } from './thread-list';
import { ThreadDialog } from './thread-dialogs';

export type ThreadSidebarProps = {
  plugin?: string;
  /** Default agent for chats created within a plugin. */
  agentId?: string;
  title?: string;
  label?: string;
  newLabel?: string;
  onNavigate?: () => void;
};

export function ThreadSidebar({
  plugin,
  agentId,
  title,
  label,
  newLabel,
  onNavigate,
}: ThreadSidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const selectedId = params.projectId ? undefined : params.threadId;
  const resource = useThreadListResource(plugin);
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [action, setAction] = useState<{
    thread: ThreadSummary;
    mode: 'rename' | 'delete';
  } | null>(null);
  const select = (id?: string) => {
    if (id)
      void navigate({ to: '/threads/$threadId', params: { threadId: id } });
    else if (plugin)
      void navigate({
        to: '/p/$pluginId/$',
        params: { pluginId: plugin, _splat: '' },
      });
    else void navigate({ to: '/threads' });
    onNavigate?.();
  };
  async function create() {
    if (!plugin) return select();
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const thread = await chatApi.create({
        plugin,
        agentId,
        model: null,
        reasoningEffort: 'auto',
      });
      resource.update(thread);
      setOpen(true);
      select(thread.id);
    } catch (cause) {
      toast.error(t(chatErrorKey(cause)));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }
  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex h-10 items-center rounded-lg">
          <CollapsibleTrigger className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left text-sm outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring">
            <MessageSquare aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {title ?? t('nav.chats')}
            </span>
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                open && 'rotate-90',
              )}
            />
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0"
            aria-label={newLabel ?? t('chat.new')}
            title={newLabel ?? t('chat.new')}
            disabled={creating}
            onClick={() => void create()}
          >
            {creating ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : (
              <Plus aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
        <CollapsibleContent>
          <div className="mt-1 mb-2">
            <ThreadList
              resource={resource}
              label={label}
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
          onSaved={resource.update}
          onDeleted={() => {
            resource.remove(action.thread.id);
            if (selectedId === action.thread.id) select();
          }}
        />
      )}
    </>
  );
}
