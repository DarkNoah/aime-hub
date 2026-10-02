import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { QueuedMessageDetail, ThreadSummary } from '@aime/shared/threads';
import { Queue, QueueItem } from '@/components/ai-elements/queue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Toggle } from '@/components/ui/toggle';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { chatApi, chatErrorKey } from './api';

export function ChatQueue({
  thread,
  disabled,
}: {
  thread: ThreadSummary;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    after: boolean;
  } | null>(null);
  const unavailable = disabled || pending;

  async function change(action: () => Promise<unknown>) {
    if (disabled || pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      await action();
      toast.success(t('chat.queueUpdated'), { id: `queue-${thread.id}` });
      return true;
    } catch (cause) {
      toast.error(t(chatErrorKey(cause)));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  const move = (id: string, beforeId: string | null) => {
    void change(() => chatApi.moveQueued(thread.id, id, beforeId));
  };
  if (!thread.queue.length) return null;
  return (
    <Queue
      aria-label={t('chat.queued', { count: thread.queue.length })}
      aria-busy={pending}
      className="mx-3 -mb-3 gap-0 rounded-b-none rounded-t-xl border-b-0 bg-muted/50 px-1.5 pt-1 pb-3 shadow-none"
    >
      {thread.status !== 'running' && thread.status !== 'stopping' && (
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <Badge variant="secondary" className="text-xs">
            {t('chat.queuePaused')}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            disabled={unavailable}
            onClick={() => void change(() => chatApi.resume(thread.id))}
          >
            <Play className="size-3" />
            {t('chat.resumeQueue')}
          </Button>
        </div>
      )}
      <ul
        className="max-h-36 overflow-y-auto overscroll-contain"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(null);
        }}
      >
        {thread.queue.map((item, index) => (
          <QueueItem
            key={item.id}
            className={cn(
              'relative flex-row items-center gap-1 px-0.5 py-0 text-xs',
              dragging === item.id && 'opacity-50',
            )}
            onDragOver={(event) => {
              if (!dragging || unavailable) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              const bounds = event.currentTarget.getBoundingClientRect();
              setDropTarget({
                id: item.id,
                after: event.clientY > bounds.top + bounds.height / 2,
              });
            }}
            onDrop={(event) => {
              if (!dragging || unavailable) return;
              event.preventDefault();
              event.stopPropagation();
              const source = dragging;
              const after = dropTarget?.id === item.id && dropTarget.after;
              const beforeId = after
                ? (thread.queue[index + 1]?.id ?? null)
                : item.id;
              setDragging(null);
              setDropTarget(null);
              if (source !== item.id && source !== beforeId)
                move(source, beforeId);
            }}
          >
            {dropTarget?.id === item.id && dragging !== item.id && (
              <span
                className={cn(
                  'pointer-events-none absolute inset-x-1 h-px bg-primary',
                  dropTarget.after ? 'bottom-0' : 'top-0',
                )}
              />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="cursor-grab text-muted-foreground active:cursor-grabbing"
              disabled={unavailable}
              draggable={!unavailable}
              aria-label={t('chat.queueDrag')}
              title={t('chat.queueDrag')}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.id);
                setDragging(item.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' && index > 0) {
                  event.preventDefault();
                  move(item.id, thread.queue[index - 1].id);
                } else if (
                  event.key === 'ArrowDown' &&
                  index < thread.queue.length - 1
                ) {
                  event.preventDefault();
                  move(item.id, thread.queue[index + 2]?.id ?? null);
                }
              }}
            >
              <GripVertical className="size-3.5" />
            </Button>
            <button
              type="button"
              disabled={unavailable}
              onClick={() => setEditing(item.id)}
              className="min-w-0 flex-1 truncate rounded px-1 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              aria-label={t('chat.editQueuedMessage', {
                text: item.text || t('chat.image'),
              })}
            >
              {item.text || t('chat.image')}
            </button>
            <Toggle
              pressed={item.isImmediate}
              disabled={unavailable}
              aria-label={t('chat.queueImmediate')}
              title={t('chat.queueImmediateHint')}
              onPressedChange={(isImmediate) =>
                void change(() =>
                  chatApi.updateQueued(thread.id, item.id, { isImmediate }),
                )
              }
            >
              <CornerDownRight />
              {t('chat.queueImmediate')}
            </Toggle>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={unavailable}
              className="text-muted-foreground hover:text-destructive"
              aria-label={t('chat.cancelQueued')}
              title={t('chat.cancelQueued')}
              onClick={() =>
                void change(() => chatApi.cancel(thread.id, item.id))
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={unavailable}
                  aria-label={t('chat.queueActions')}
                  className="text-muted-foreground"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(item.id)}>
                  <Pencil />
                  {t('chat.editQueued')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === 0}
                  onSelect={() => move(item.id, thread.queue[index - 1].id)}
                >
                  <ArrowUp />
                  {t('chat.queueMoveUp')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === thread.queue.length - 1}
                  onSelect={() =>
                    move(item.id, thread.queue[index + 2]?.id ?? null)
                  }
                >
                  <ArrowDown />
                  {t('chat.queueMoveDown')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </QueueItem>
        ))}
      </ul>
      {editing && thread.queue.some((item) => item.id === editing) && (
        <QueuedMessageDialog
          key={editing}
          threadId={thread.id}
          messageId={editing}
          disabled={unavailable}
          onClose={() => setEditing(null)}
          onSave={(text) =>
            change(() => chatApi.updateQueued(thread.id, editing, { text }))
          }
        />
      )}
    </Queue>
  );
}

function QueuedMessageDialog({
  threadId,
  messageId,
  disabled,
  onClose,
  onSave,
}: {
  threadId: string;
  messageId: string;
  disabled?: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<QueuedMessageDetail | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const invalid = !!detail && !text.trim() && !detail.hasAttachments;
  useEffect(() => {
    const controller = new AbortController();
    void chatApi
      .queued(threadId, messageId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setDetail(value);
        setText(value.text);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause);
          toast.error(t(chatErrorKey(cause)));
        }
      });
    return () => controller.abort();
  }, [threadId, messageId, t]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !disabled) onClose();
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!detail || disabled || invalid) return;
            void onSave(text).then((saved) => {
              if (saved) onClose();
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('chat.editQueued')}</DialogTitle>
            <DialogDescription>{t('chat.editQueuedHint')}</DialogDescription>
          </DialogHeader>
          <div className="my-5 space-y-2">
            <Label htmlFor={`queued-text-${messageId}`}>
              {t('chat.message')}
            </Label>
            <Textarea
              id={`queued-text-${messageId}`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={!detail || disabled}
              maxLength={60000}
              aria-invalid={invalid}
              className="min-h-32 max-h-72 resize-y"
            />
            {!detail && !error && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('chat.loading')}
              </p>
            )}
            {detail?.hasAttachments && (
              <p className="text-xs text-muted-foreground">
                {t('chat.queueAttachmentsKept')}
              </p>
            )}
            {invalid && (
              <p role="alert" className="text-sm text-destructive">
                {t('chat.queueEmpty')}
              </p>
            )}
            {!!error && (
              <p role="alert" className="text-sm text-destructive">
                {t(chatErrorKey(error))}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={onClose}
            >
              {t('users.cancel')}
            </Button>
            <Button type="submit" disabled={!detail || disabled || invalid}>
              {t(disabled ? 'users.saving' : 'users.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
