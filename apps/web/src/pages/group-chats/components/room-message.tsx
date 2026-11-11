import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, Reply, SmilePlus } from 'lucide-react';
import { toast } from 'sonner';
import type { GroupChatMessage, MemberProfile } from '@aime/shared/group-chats';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { IntelligentUI } from '@/components/chat/tool-renderers/intelligent-ui';
import { MemberAvatar } from '@/components/member-avatar';
import { WorkspaceAttachment } from '@/components/file-manager/workspace-attachment';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { groupChatErrorKey } from '../api';
import { useReactionFeedback } from './use-reaction-feedback';
import { RoomAgentAvatar } from './room-agent-avatar';
import { RoomMessageChoices } from './room-message-choices';

const emojiChoices = ['👍', '❤️', '🎉', '👀', '✅', '🤔', '⭐'];

export function RoomMessage({
  message,
  reply,
  userId,
  label,
  profile,
  targetName,
  fileThreadId,
  onReply,
  onJumpToReply,
  loadingReply,
  onMention,
  onReact,
  onRespondUi,
  submittedChoices,
  onRespondChoices,
}: {
  message: GroupChatMessage;
  reply?: GroupChatMessage;
  userId: string;
  label: string;
  profile?: MemberProfile;
  targetName?: string;
  fileThreadId?: string;
  onReply: () => void;
  onJumpToReply: () => void;
  loadingReply: boolean;
  onMention?: () => void;
  onReact: (emoji: string, active: boolean) => Promise<void>;
  onRespondUi: (
    id: string,
    data: NonNullable<GroupChatMessage['uiResponse']>['data'],
  ) => Promise<void>;
  submittedChoices?: string[];
  onRespondChoices: (id: string, selectedOptions: string[]) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [reacting, setReacting] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const reactionsRef = useReactionFeedback(message.reactions);
  const own = message.senderKind === 'user' && message.senderId === userId;
  async function react(emoji: string) {
    if (reacting) return;
    setReacting(true);
    setReactionsOpen(false);
    try {
      const active = !(message.reactions ?? []).some(
        (reaction) =>
          reaction.emoji === emoji && reaction.memberIds.includes(userId),
      );
      await onReact(emoji, active);
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setReacting(false);
    }
  }
  return (
    <div
      data-chat-turn={message.id}
      tabIndex={-1}
      className={`group flex min-w-0 gap-3 rounded-lg outline-none transition-colors duration-500 data-[message-highlight]:bg-primary/10 motion-reduce:transition-none ${own ? 'flex-row-reverse' : ''}`}
    >
      {message.senderKind !== 'user' ? (
        <RoomAgentAvatar
          name={label}
          external={message.senderKind === 'a2a'}
          onMention={onMention}
        />
      ) : (
        <MemberAvatar member={profile} label={label} />
      )}
      <Message
        from={own ? 'user' : 'assistant'}
        className={`min-w-0 gap-1 ${message.ui ? 'w-full max-w-[calc(100%-2.75rem)]' : 'max-w-[85%]'}`}
      >
        <div
          className={`flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground ${own ? 'justify-end' : ''}`}
        >
          <span className="max-w-48 truncate font-medium text-foreground">
            {own ? t('groupChat.you') : label}
          </span>
          {message.senderKind !== 'user' && (
            <Badge variant="outline" className="px-1 py-0 text-[10px]">
              {message.senderKind === 'a2a' ? 'A2A' : 'Agent'}
            </Badge>
          )}
          <time
            dateTime={message.createdAt}
            title={new Date(message.createdAt).toLocaleString(i18n.language)}
          >
            {new Date(message.createdAt).toLocaleString(i18n.language, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        {message.replyToId && (
          <button
            type="button"
            onClick={onJumpToReply}
            disabled={loadingReply}
            aria-busy={loadingReply}
            aria-label={t('groupChat.jumpToOriginal')}
            title={t('groupChat.jumpToOriginal')}
            className="max-w-full cursor-pointer truncate rounded-r border-l-2 border-primary/40 px-2 py-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-primary/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
          >
            {loadingReply ? (
              <LoaderCircle className="mr-1 inline size-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Reply className="mr-1 inline size-3" />
            )}
            {reply?.text ||
              reply?.ui?.title ||
              reply?.files?.[0]?.name ||
              t('groupChat.replyMessage')}
          </button>
        )}
        {message.text && (
          <MessageContent className="rounded-lg bg-muted/60 px-4 py-3 [overflow-wrap:anywhere]">
            {message.senderKind === 'agent' ? (
              <MessageResponse workspaceThreadId={fileThreadId}>
                {message.text}
              </MessageResponse>
            ) : (
              <span className="whitespace-pre-wrap">{message.text}</span>
            )}
          </MessageContent>
        )}
        {targetName && (
          <Badge variant="secondary" className="mt-1">
            {t('groupChat.taskFor', { name: targetName })}
          </Badge>
        )}
        {!!message.files?.length && (
          <div className="grid min-w-0 gap-2 py-1">
            {message.files.map((file) => (
              <WorkspaceAttachment
                key={file.path}
                threadId={fileThreadId}
                file={file}
              />
            ))}
          </div>
        )}
        {message.ui && (
          <div className="w-full min-w-0">
            <IntelligentUI
              nonBlocking={{ input: message.ui, onSend: onRespondUi }}
            />
          </div>
        )}
        {message.choices && (
          <RoomMessageChoices
            key={`${message.id}:${userId}`}
            choices={message.choices}
            submittedOptions={submittedChoices}
            onSend={onRespondChoices}
          />
        )}
        <div
          ref={reactionsRef}
          className={`flex flex-wrap items-center gap-1 ${own ? 'justify-end' : ''}`}
        >
          {(message.reactions ?? []).map((reaction) => (
            <Button
              key={reaction.emoji}
              type="button"
              size="sm"
              variant={
                reaction.memberIds.includes(userId) ? 'secondary' : 'ghost'
              }
              className="h-7 gap-1 rounded-full px-2 text-xs"
              disabled={reacting}
              aria-pressed={reaction.memberIds.includes(userId)}
              aria-label={t('groupChat.reactionCount', {
                emoji:
                  reaction.emoji === '⭐'
                    ? `⭐ ${t('groupChat.bookmark')}`
                    : reaction.emoji,
                count: reaction.memberIds.length,
              })}
              onClick={() => void react(reaction.emoji)}
            >
              <span
                data-reaction-emoji={reaction.emoji}
                className="inline-flex items-center justify-center"
                aria-hidden="true"
              >
                {reaction.emoji}
              </span>
              {reaction.emoji === '⭐' && t('groupChat.bookmark')}
              <span className="tabular-nums">{reaction.memberIds.length}</span>
            </Button>
          ))}
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground"
                aria-label={t('groupChat.addReaction')}
                disabled={reacting}
              >
                <SmilePlus className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-auto p-1"
              align={own ? 'end' : 'start'}
            >
              <div className="flex">
                {emojiChoices.map((emoji) => (
                  <Button
                    key={emoji}
                    type="button"
                    variant="ghost"
                    size={emoji === '⭐' ? 'sm' : 'icon-sm'}
                    aria-label={
                      emoji === '⭐' ? `⭐ ${t('groupChat.bookmark')}` : emoji
                    }
                    onClick={() => void react(emoji)}
                  >
                    {emoji}
                    {emoji === '⭐' && t('groupChat.bookmark')}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground"
            aria-label={t('groupChat.reply')}
            onClick={onReply}
          >
            <Reply className="size-3.5" />
          </Button>
        </div>
      </Message>
    </div>
  );
}
