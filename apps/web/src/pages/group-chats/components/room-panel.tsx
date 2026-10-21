import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MessageSquare, Users } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { ChatConversation } from '@/components/chat/chat-conversation';
import { ChatHistoryLoader } from '@/components/chat/chat-history-loader';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { MemberAvatar } from '@/components/member-avatar';
import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { useRoom } from '../use-room';
import { RoomComposer } from './room-composer';

export function RoomPanel({
  roomId,
  projectId,
  userId,
}: {
  roomId: string;
  projectId?: string;
  userId: string;
}) {
  const { t, i18n } = useTranslation();
  const state = useRoom(roomId, projectId);
  const [membersOpen, setMembersOpen] = useState(false);
  const name = (id: string) =>
    state.profiles.get(id)?.name ||
    state.profiles.get(id)?.username ||
    t('groupChat.unknownMember');
  if (state.loading)
    return (
      <div
        className="flex flex-1 flex-col gap-6 p-6"
        aria-label={t('chat.loading')}
      >
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-1/2" />
      </div>
    );
  if (state.error || !state.room)
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-4 p-6"
      >
        <p>{state.error ? t(state.error) : t('groupChat.unavailable')}</p>
        <div className="flex gap-2">
          <Button onClick={state.retry}>{t('chat.retry')}</Button>
        </div>
      </div>
    );
  const { room } = state;
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={t('groupChat.heading')}
    >
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3">
        {projectId && (
          <Button asChild variant="ghost" size="icon-sm">
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              aria-label={t('projects.dashboard')}
            >
              <ArrowLeft />
            </Link>
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {t('groupChat.heading')}
          </h1>
          <Badge variant="secondary" className="mt-1 text-[10px]">
            {t(room.projectId ? 'groupChat.project' : 'groupChat.personal')}
          </Badge>
        </div>
        <button
          type="button"
          onClick={() => setMembersOpen(true)}
          className="flex shrink-0 items-center gap-2 rounded-md p-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('groupChat.members', { count: room.memberIds.length })}
        >
          {room.projectId && (
            <AvatarGroup className="hidden sm:flex">
              {room.memberIds.slice(0, 4).map((id) => (
                <MemberAvatar
                  key={id}
                  member={state.profiles.get(id)}
                  label={name(id)}
                  size="sm"
                />
              ))}
              {room.memberIds.length > 4 && (
                <AvatarGroupCount className="size-6 text-xs">
                  +{room.memberIds.length - 4}
                </AvatarGroupCount>
              )}
            </AvatarGroup>
          )}
          <Users className="size-4 sm:hidden" />
          <span className="text-xs text-muted-foreground">
            {t('groupChat.members', { count: room.memberIds.length })}
          </span>
        </button>
      </header>
      {state.syncError && (
        <div
          role="status"
          className="border-b px-4 py-2 text-xs text-muted-foreground"
        >
          {t('groupChat.reconnecting')}
        </div>
      )}
      <ChatConversation
        contentClassName="mx-auto w-full max-w-3xl gap-5"
        composer={
          <RoomComposer roomId={roomId} userId={userId} onSend={state.send} />
        }
      >
        <ChatHistoryLoader
          hasEarlier={state.hasEarlier}
          loading={state.loadingEarlier}
          loadEarlier={state.loadEarlier}
          firstTurnId={state.messages[0]?.id}
        />
        {!state.messages.length && (
          <ConversationEmptyState
            icon={<MessageSquare className="size-8" />}
            title={t('groupChat.emptyMessages')}
            description={t(
              room.projectId
                ? 'groupChat.projectMessageHint'
                : 'groupChat.personalMessageHint',
            )}
          />
        )}
        {state.messages.map((message) => {
          const own = message.senderId === userId;
          const label = name(message.senderId);
          return (
            <div
              key={message.id}
              data-chat-turn={message.id}
              className={`flex min-w-0 gap-3 ${own ? 'flex-row-reverse' : ''}`}
            >
              {room.projectId && (
                <MemberAvatar
                  member={state.profiles.get(message.senderId)}
                  label={label}
                />
              )}
              <Message
                from={own ? 'user' : 'assistant'}
                className="min-w-0 max-w-[85%] gap-1"
              >
                <div
                  className={`flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground ${own ? 'justify-end' : ''}`}
                >
                  <span className="max-w-48 truncate font-medium text-foreground">
                    {own ? t('groupChat.you') : label}
                  </span>
                  <time
                    dateTime={message.createdAt}
                    title={new Date(message.createdAt).toLocaleString(
                      i18n.language,
                    )}
                  >
                    {new Date(message.createdAt).toLocaleString(i18n.language, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <MessageContent className="rounded-lg bg-muted/60 px-4 py-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {message.text}
                </MessageContent>
              </Message>
            </div>
          );
        })}
      </ChatConversation>
      <Sheet open={membersOpen} onOpenChange={setMembersOpen}>
        <SheetContent>
          <div className="space-y-2 px-6 pt-6">
            <SheetTitle>
              {t('groupChat.members', { count: room.memberIds.length })}
            </SheetTitle>
            <SheetDescription>
              {t(
                room.projectId
                  ? 'groupChat.projectHint'
                  : 'groupChat.personalHint',
              )}
            </SheetDescription>
          </div>
          <ScrollArea
            className="min-h-0 flex-1"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <ul className="space-y-4 p-4">
              {room.memberIds.map((id) => (
                <li key={id} className="flex items-center gap-3">
                  <MemberAvatar
                    member={state.profiles.get(id)}
                    label={name(id)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{name(id)}</p>
                    {state.profiles.get(id)?.username && (
                      <p className="truncate text-xs text-muted-foreground">
                        @{state.profiles.get(id)?.username}
                      </p>
                    )}
                  </div>
                  {id === userId && (
                    <Badge variant="secondary">{t('groupChat.you')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </section>
  );
}
