import {
  lazy,
  Suspense,
  useContext,
  useMemo,
  useState,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import type { UIMessage } from 'ai';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MessageSquare, Users } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type {
  GroupChatAgent,
  GroupChatA2AMember,
  GroupChatMessage,
} from '@aime/shared/group-chats';
import { ChatConversation } from '@/components/chat/chat-conversation';
import { ChatHistoryLoader } from '@/components/chat/chat-history-loader';
import { ChatWorkspace } from '@/components/chat/chat-workspace';
import {
  ChatWorkspaceMenuContext,
  ChatWorkspacePanelContext,
} from '@/components/chat/layout-context';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { MemberAvatar } from '@/components/member-avatar';
import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useRoom } from '../use-room';
import { RoomComposer, type RoomComposerHandle } from './room-composer';
import { RoomReadMarker } from './room-read-marker';
import { RoomMessage } from './room-message';
import { RoomAgentEditor } from './room-agent-editor';
import { RoomMembersPanel } from './room-members-panel';
import { AgentStatus } from './agent-status';
import { RoomMemberEditor } from './room-member-editor';
import { RoomAgentPicker } from './room-agent-picker';
import { RoomA2aEditor } from './room-a2a-editor';

const RoomAgentThreadWindow = lazy(() => import('./room-agent-thread-window'));

export function RoomPanel({
  roomId,
  projectId,
  userId,
  roomSwitcher,
}: {
  roomId: string;
  projectId?: string;
  userId: string;
  roomSwitcher?: ReactNode;
}) {
  const { t } = useTranslation();
  const state = useRoom(roomId, projectId);
  const composer = useRef<RoomComposerHandle>(null);
  const [editor, setEditor] = useState<GroupChatAgent | 'new' | null>(null);
  const [memberEditor, setMemberEditor] = useState(false);
  const [a2aEditor, setA2aEditor] = useState<GroupChatA2AMember | 'new' | null>(
    null,
  );
  const [threadAgentId, setThreadAgentId] = useState<string | null>(null);
  const visibleMessages = useMemo<UIMessage[]>(
    () =>
      state.messages.map((message) => ({
        id: message.id,
        role: message.senderKind === 'user' ? 'user' : 'assistant',
        metadata: { senderId: message.senderId, createdAt: message.createdAt },
        parts: [
          {
            type: 'text',
            text: [
              message.text,
              ...(message.files ?? []).map(
                (file) => `${file.name}: ${file.path}`,
              ),
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      })),
    [state.messages],
  );
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
        <Button onClick={state.retry}>{t('chat.retry')}</Button>
      </div>
    );
  const bot = state.room.agents?.find(
    (agent) => agent.id === state.room!.botAgentId,
  );
  const threadAgent = state.room.agents.find(
    (agent) => agent.id === threadAgentId,
  );
  return (
    <ChatWorkspace
      threadId={bot?.threadId}
      messages={visibleMessages}
      projectId={projectId}
      defaultFileScope={projectId ? 'thread' : 'shared'}
      extraPanel={{
        title: t('groupChat.participants'),
        icon: Users,
        render: (onClose) => (
          <RoomMembersPanel
            room={state.room!}
            profiles={state.profiles}
            userId={userId}
            onEdit={setEditor}
            onAddMember={() => setMemberEditor(true)}
            onEditA2a={setA2aEditor}
            onA2aUpdated={state.updateA2aMember}
            onA2aRemoved={state.removeA2aMember}
            onAgentUpdated={state.updateAgent}
            onAgentRemoved={state.removeAgent}
            onOpenThread={(agent) => setThreadAgentId(agent.id)}
            onMention={(agent) => {
              onClose(() => composer.current?.mention(agent));
            }}
            onClose={() => onClose()}
          />
        ),
      }}
      assetRevision={state.messages
        .filter((message) => message.files?.length)
        .map((message) => message.id)
        .join(',')}
    >
      <RoomContent
        state={state}
        composer={composer}
        roomId={roomId}
        projectId={projectId}
        userId={userId}
        onEditAgent={setEditor}
        roomSwitcher={roomSwitcher}
      />
      {editor === 'new' && (
        <RoomAgentPicker
          roomId={roomId}
          projectId={projectId}
          agents={state.room.agents}
          onSaved={state.updateAgent}
          onClose={() => setEditor(null)}
        />
      )}
      {editor && editor !== 'new' && (
        <RoomAgentEditor
          key={editor.id}
          roomId={roomId}
          projectId={projectId}
          agent={editor}
          onSaved={state.updateAgent}
          onClose={() => setEditor(null)}
        />
      )}
      {memberEditor && state.room.canManageMembers && (
        <RoomMemberEditor
          roomId={roomId}
          projectId={projectId}
          onAdded={state.addMember}
          onClose={() => setMemberEditor(false)}
        />
      )}
      {threadAgent && (
        <Suspense fallback={null}>
          <RoomAgentThreadWindow
            agent={threadAgent}
            projectId={projectId}
            onClose={() => setThreadAgentId(null)}
          />
        </Suspense>
      )}
      {a2aEditor && state.room.canManageMembers && (
        <RoomA2aEditor
          key={a2aEditor === 'new' ? 'new' : a2aEditor.id}
          roomId={roomId}
          member={a2aEditor === 'new' ? undefined : a2aEditor}
          onSaved={state.updateA2aMember}
          onClose={() => setA2aEditor(null)}
        />
      )}
    </ChatWorkspace>
  );
}

function RoomContent({
  state,
  composer,
  roomId,
  projectId,
  userId,
  onEditAgent,
  roomSwitcher,
}: {
  state: ReturnType<typeof useRoom>;
  composer: RefObject<RoomComposerHandle | null>;
  roomId: string;
  projectId?: string;
  userId: string;
  onEditAgent: (agent: GroupChatAgent) => void;
  roomSwitcher?: ReactNode;
}) {
  const { t } = useTranslation();
  const workspaceMenu = useContext(ChatWorkspaceMenuContext);
  const openMembersPanel = useContext(ChatWorkspacePanelContext);
  const [reply, setReply] = useState<GroupChatMessage | null>(null);
  const room = state.room!;
  const agents = room.agents ?? [];
  const bot = agents.find((agent) => agent.id === room.botAgentId);
  const a2aMembers = room.a2aMembers ?? [];
  const mentionMembers = new Map(
    [
      ...agents.filter((agent) => agent.enabled),
      ...a2aMembers.filter((agent) => agent.enabled && !agent.revokedAt),
    ].map((agent) => [agent.id, agent]),
  );
  function mention(memberId: string) {
    const member = mentionMembers.get(memberId);
    if (member) composer.current?.mention(member);
  }
  const members = room.memberIds.length + agents.length + a2aMembers.length;
  const name = (id: string, fallback?: string | null) =>
    agents.find((agent) => agent.id === id)?.name ||
    a2aMembers.find((member) => member.id === id)?.name ||
    state.profiles.get(id)?.name ||
    state.profiles.get(id)?.username ||
    fallback ||
    t('groupChat.unknownMember');
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={t('groupChat.heading')}
    >
      <header
        data-chat-header
        className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3"
      >
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
          {roomSwitcher ?? (
            <h1 className="truncate text-sm font-semibold">
              {t('groupChat.heading')}
            </h1>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {t(room.projectId ? 'groupChat.project' : 'groupChat.personal')}
            </Badge>
            {bot && <AgentStatus agent={bot} />}
          </div>
        </div>
        <button
          data-group-chat-members
          type="button"
          onClick={() => openMembersPanel?.()}
          className="flex shrink-0 items-center gap-2 rounded-md p-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('groupChat.members', { count: members })}
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
            {t('groupChat.members', { count: members })}
          </span>
        </button>
        {workspaceMenu}
      </header>
      {bot?.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive"
        >
          <span>
            {t('groupChat.agentError')}: {bot.error}
          </span>
          {room.canManage && (
            <Button variant="ghost" size="sm" onClick={() => onEditAgent(bot)}>
              {t('groupChat.configure')}
            </Button>
          )}
        </div>
      )}
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
          <RoomComposer
            ref={composer}
            roomId={roomId}
            fileThreadId={bot?.threadId}
            agents={agents}
            a2aMembers={a2aMembers}
            userId={userId}
            reply={
              reply
                ? {
                    id: reply.id,
                    name: name(reply.senderId, reply.senderName),
                    text:
                      reply.text ||
                      reply.ui?.title ||
                      t('groupChat.replyMessage'),
                  }
                : undefined
            }
            onCancelReply={() => setReply(null)}
            onSend={async (id, text, replyToId, files) => {
              await state.send(id, text, replyToId, files);
              setReply(null);
            }}
          />
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
        {state.messages.map((message) => (
          <RoomMessage
            key={message.id}
            message={message}
            fileThreadId={bot?.threadId}
            reply={message.replyToId ? byId.get(message.replyToId) : undefined}
            userId={userId}
            label={name(message.senderId, message.senderName)}
            profile={state.profiles.get(message.senderId)}
            targetName={
              message.targetAgentId ? name(message.targetAgentId) : undefined
            }
            onReply={() => setReply(message)}
            onMention={
              message.senderKind !== 'user' &&
              mentionMembers.has(message.senderId)
                ? () => mention(message.senderId)
                : undefined
            }
            onReact={(emoji, active) => state.react(message.id, emoji, active)}
            onRespondUi={(id, data) => state.respondUi(message.id, id, data)}
          />
        ))}
        <RoomReadMarker
          roomId={roomId}
          sequence={state.messages.at(-1)?.sequence}
        />
      </ChatConversation>
    </section>
  );
}
