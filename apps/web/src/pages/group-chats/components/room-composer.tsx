import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowUp, X } from 'lucide-react';
import { MAX_CHAT_FILES } from '@aime/shared/threads';
import {
  roomAgentMention,
  type GroupChatAgent,
  type GroupChatA2AMember,
  type GroupChatFile,
} from '@aime/shared/group-chats';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input';
import { ChatCommandTextarea } from '@/components/chat/chat-command-textarea';
import { ComposerAttachmentMenu } from '@/components/chat/composer-attachment-menu';
import { ComposerAttachments } from '@/components/chat/composer-attachments';
import { DrawingDialog } from '@/components/chat/drawing-dialog';
import { useChatUploads } from '@/components/chat/use-chat-uploads';
import type { ChatUpload } from '@/components/chat/chat-uploads';
import {
  getMentionCommand,
  insertMention,
} from '@/components/chat/slash-command';
import { useChatDraft } from '@/components/chat/use-chat-draft';
import { Button } from '@/components/ui/button';
import { groupChatErrorKey } from '../api';

export type RoomMentionMember = GroupChatAgent | GroupChatA2AMember;
export type RoomComposerHandle = {
  mention: (member: RoomMentionMember) => void;
};
const noop = () => {};

export function RoomComposer({
  ref,
  roomId,
  userId,
  fileThreadId,
  agents,
  a2aMembers = [],
  onSend,
  reply,
  onCancelReply,
}: {
  ref?: Ref<RoomComposerHandle>;
  roomId: string;
  userId: string;
  fileThreadId?: string;
  agents: GroupChatAgent[];
  a2aMembers?: GroupChatA2AMember[];
  reply?: { id: string; name: string; text: string };
  onCancelReply: () => void;
  onSend: (
    id: string,
    text: string,
    replyToId?: string,
    files?: GroupChatFile[],
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const replyToId = reply?.id;
  const { text, setText, clear } = useChatDraft({
    userId,
    groupChatId: roomId,
  });
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [capturing, setCapturing] = useState(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [editingDrawing, setEditingDrawing] = useState<ChatUpload | null>(null);
  const retry = useRef<{ id: string; signature: string } | null>(null);
  const uploads = useChatUploads(async () => {
    if (!fileThreadId) throw new Error('Room workspace is unavailable');
    return fileThreadId;
  });
  const mentionMembers = [
    ...agents,
    ...a2aMembers.filter((member) => !member.revokedAt),
  ];
  const groups = [
    {
      id: 'room-members',
      label: t('groupChat.mentionAgent'),
      sections: [
        {
          id: 'room-members',
          items: mentionMembers
            .filter((member) => member.enabled)
            .map((member) => ({
              id: member.id,
              name: member.name,
              description: t(
                !('role' in member)
                  ? 'groupChat.a2a.member'
                  : member.role === 'bot'
                    ? 'groupChat.bot'
                    : 'groupChat.worker',
              ),
              action: 'mention' as const,
              mention: roomAgentMention(member, mentionMembers),
              keywords: [member.id],
            })),
        },
      ],
    },
  ];
  useImperativeHandle(ref, () => ({
    mention(member) {
      if (
        busy.current ||
        !member.enabled ||
        ('revokedAt' in member && member.revokedAt)
      )
        return;
      const start = textarea.current?.selectionStart ?? text.length;
      const end = textarea.current?.selectionEnd ?? start;
      const command = getMentionCommand(text, start, end);
      const next = insertMention(
        text,
        command?.start ?? start,
        end,
        roomAgentMention(member, mentionMembers),
      );
      if (next.text.length > 20_000) {
        toast.error(t('groupChat.invalid'));
        return;
      }
      setText(next.text);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(next.caret, next.caret);
      });
    },
  }));

  function openDrawing() {
    if (busy.current || !fileThreadId || capturing) return;
    if (uploads.queue.getSnapshot().length >= MAX_CHAT_FILES) {
      toast.error(t('assets.limit', { count: MAX_CHAT_FILES }));
      return;
    }
    setEditingDrawing(null);
    setDrawingOpen(true);
  }
  return (
    <div
      className="pointer-events-auto mx-auto w-full max-w-3xl px-4 pb-4"
      data-chat-composer
    >
      <PromptInput
        className="relative [&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:bg-card"
        multiple
        onFilesAdded={(files) => {
          if (busy.current || !fileThreadId || drawingOpen) return;
          uploads.queue.add(files);
        }}
        onSubmit={async ({ text: draft }) => {
          const attached = uploads.queue.getSnapshot();
          if (
            busy.current ||
            capturing ||
            drawingOpen ||
            attached.some((item) => item.status !== 'done' || !item.path) ||
            (!draft.trim() && !attached.length)
          )
            throw new Error('Unavailable');
          const files = attached.map((item) => ({
            path: `./${item.path}`,
            name: item.file.name,
          }));
          const body =
            draft.trim() || files.map((file) => file.name).join(', ');
          const signature = JSON.stringify({ text: body, replyToId, files });
          const attempt =
            retry.current?.signature === signature
              ? retry.current
              : { id: nanoid(), signature };
          retry.current = attempt;
          busy.current = true;
          setPending(true);
          try {
            await onSend(attempt.id, body, replyToId, files);
            uploads.queue.commit();
            clear(draft);
            retry.current = null;
          } catch (cause) {
            toast.error(t(groupChatErrorKey(cause)));
            throw cause;
          } finally {
            busy.current = false;
            setPending(false);
          }
        }}
      >
        {reply && (
          <PromptInputHeader className="min-w-0 flex-nowrap gap-2 border-b bg-muted/40 py-1.5">
            <p className="min-w-0 flex-1 truncate text-xs font-normal">
              {t('groupChat.replyingTo', { name: reply.name })} · {reply.text}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={t('groupChat.cancelReply')}
              disabled={pending}
              onClick={onCancelReply}
            >
              <X className="size-3.5" />
            </Button>
          </PromptInputHeader>
        )}
        <ComposerAttachments
          items={uploads.items}
          queue={uploads.queue}
          disabled={pending}
          onEditDrawing={(item) => {
            if (busy.current || capturing) return;
            setEditingDrawing(item);
            setDrawingOpen(true);
          }}
        />
        <PromptInputBody>
          <ChatCommandTextarea
            inputRef={textarea}
            trigger="@"
            value={text}
            onValueChange={setText}
            groups={groups}
            loading={false}
            onRetry={noop}
            onOpenChange={noop}
            placeholder={t('groupChat.placeholder')}
            ariaLabel={t('groupChat.placeholder')}
            maxLength={20_000}
            disabled={pending}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <div className="flex min-w-0 items-center gap-2">
            <ComposerAttachmentMenu
              disabled={pending || !fileThreadId || drawingOpen}
              capturing={capturing}
              onCapturingChange={setCapturing}
              onDraw={openDrawing}
            />
            <span className="truncate text-xs text-muted-foreground">
              {t('groupChat.mentionHint')}
            </span>
          </div>
          <PromptInputSubmit
            disabled={
              pending ||
              capturing ||
              drawingOpen ||
              uploads.blocked ||
              (!text.trim() && !uploads.items.length)
            }
            status={pending ? 'submitted' : 'ready'}
            aria-label={t('groupChat.send')}
            title={t('groupChat.send')}
          >
            <ArrowUp />
          </PromptInputSubmit>
        </PromptInputFooter>
      </PromptInput>
      {drawingOpen && (
        <DrawingDialog
          initialSnapshot={editingDrawing?.drawing}
          onCancel={() => {
            setDrawingOpen(false);
            setEditingDrawing(null);
          }}
          onRestoreFocus={() => textarea.current?.focus()}
          onComplete={(file, snapshot) => {
            if (busy.current || !fileThreadId) return false;
            // Room attachments are durable workspace files, including drawings.
            const added = editingDrawing
              ? uploads.queue.replaceDrawing(editingDrawing.id, file, snapshot)
              : uploads.queue.add([file], 0, snapshot);
            if (added) {
              setDrawingOpen(false);
              setEditingDrawing(null);
              toast.success(
                t(
                  editingDrawing
                    ? 'chat.drawing.updated'
                    : 'chat.drawing.added',
                ),
              );
            }
            return added;
          }}
        />
      )}
    </div>
  );
}
