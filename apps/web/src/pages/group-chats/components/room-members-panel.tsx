import { useState } from 'react';
import {
  Cable,
  MessageSquareText,
  PanelRightClose,
  Plus,
  Settings2,
  Trash2,
  Users,
  UserPlus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  GroupChatAgent,
  GroupChatA2AMember,
  GroupChatDetail,
  MemberProfile,
} from '@aime/shared/group-chats';
import { MemberAvatar } from '@/components/member-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { groupChatApi, groupChatErrorKey } from '../api';
import { AgentStatus } from './agent-status';
import { RoomA2aMember } from './room-a2a-member';
import { RoomAgentAvatar } from './room-agent-avatar';

export function RoomMembersPanel({
  room,
  profiles,
  userId,
  onEdit,
  onAddMember,
  onEditA2a,
  onA2aUpdated,
  onA2aRemoved,
  onAgentUpdated,
  onAgentRemoved,
  onOpenThread,
  onMention,
  onClose,
}: {
  room: GroupChatDetail;
  profiles: Map<string, MemberProfile>;
  userId: string;
  onEdit: (agent: GroupChatAgent | 'new') => void;
  onAddMember: () => void;
  onEditA2a: (member: GroupChatA2AMember | 'new') => void;
  onA2aUpdated: (member: GroupChatA2AMember) => void;
  onA2aRemoved: (memberId: string) => void;
  onAgentUpdated: (agent: GroupChatAgent) => void;
  onAgentRemoved: (agentId: string) => void;
  onOpenThread: (agent: GroupChatAgent) => void;
  onMention: (agent: GroupChatAgent | GroupChatA2AMember) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [changingAgent, setChangingAgent] = useState<string | null>(null);
  const agents = [...room.agents].sort(
    (left, right) => Number(right.role === 'bot') - Number(left.role === 'bot'),
  );
  const a2aMembers = room.a2aMembers ?? [];
  const count = agents.length + room.memberIds.length + a2aMembers.length;

  async function toggleAgent(agent: GroupChatAgent, enabled: boolean) {
    if (changingAgent) return;
    setChangingAgent(agent.id);
    try {
      onAgentUpdated(
        await groupChatApi.updateAgent(room.id, agent.id, { enabled }),
      );
      toast.success(t('groupChat.agentSaved'));
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setChangingAgent(null);
    }
  }

  async function removeAgent(agent: GroupChatAgent) {
    if (changingAgent) return;
    setChangingAgent(agent.id);
    try {
      await groupChatApi.removeAgent(room.id, agent.id);
      onAgentRemoved(agent.id);
      toast.success(t('groupChat.agentRemoved'));
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setChangingAgent(null);
    }
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-card"
      aria-label={t('groupChat.participants')}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Users className="size-4 text-primary" aria-hidden="true" />
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {t('groupChat.participants')}
        </h2>
        <Badge
          variant="secondary"
          aria-label={t('groupChat.members', { count })}
        >
          {count}
        </Badge>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <PanelRightClose className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className="space-y-3 border-b px-4 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            room.projectId ? 'groupChat.projectHint' : 'groupChat.personalHint',
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {room.canManageMembers && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAddMember}
            >
              <UserPlus className="size-3.5" aria-hidden="true" />
              {t('groupChat.addMember')}
            </Button>
          )}
          {room.canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!!changingAgent}
              onClick={() => onEdit('new')}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('groupChat.addAgent')}
            </Button>
          )}
          {room.canManageMembers && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onEditA2a('new')}
            >
              <Cable className="size-3.5" aria-hidden="true" />
              {t('groupChat.a2a.add')}
            </Button>
          )}
        </div>
      </div>
      <ScrollArea
        className="min-h-0 flex-1"
        viewportProps={{ className: '[&>div]:block!' }}
      >
        <ul className="divide-y px-4" aria-label={t('groupChat.participants')}>
          {agents.map((agent) => (
            <li key={agent.id} className="flex gap-3 py-4">
              <RoomAgentAvatar
                name={agent.name}
                onMention={agent.enabled ? () => onMention(agent) : undefined}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p
                    className="min-w-0 truncate text-sm font-medium"
                    title={agent.name}
                  >
                    {agent.name}
                  </p>
                  <Badge variant="outline">
                    {t(
                      agent.role === 'bot'
                        ? 'groupChat.bot'
                        : 'groupChat.worker',
                    )}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <AgentStatus agent={agent} />
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        onClose();
                        onOpenThread(agent);
                      }}
                      aria-label={t('groupChat.viewAgentThread', {
                        name: agent.name,
                      })}
                      title={t('groupChat.viewAgentThread', {
                        name: agent.name,
                      })}
                    >
                      <MessageSquareText
                        className="size-3.5"
                        aria-hidden="true"
                      />
                    </Button>
                    {room.canManage && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('groupChat.configureAgent', {
                            name: agent.name,
                          })}
                          title={t('groupChat.configureAgent', {
                            name: agent.name,
                          })}
                          disabled={!!changingAgent}
                          onClick={() => onEdit(agent)}
                        >
                          <Settings2 className="size-3.5" aria-hidden="true" />
                        </Button>
                        {agent.role !== 'bot' && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('groupChat.removeAgent', {
                              name: agent.name,
                            })}
                            title={t('groupChat.removeAgent', {
                              name: agent.name,
                            })}
                            disabled={
                              !!changingAgent || agent.status === 'running'
                            }
                            onClick={() => void removeAgent(agent)}
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </Button>
                        )}
                        {agent.role !== 'bot' && (
                          <Switch
                            checked={agent.enabled}
                            disabled={!!changingAgent}
                            aria-label={t('groupChat.toggleAgent', {
                              name: agent.name,
                            })}
                            onCheckedChange={(enabled) =>
                              void toggleAgent(agent, enabled)
                            }
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
                {agent.error && (
                  <p className="break-words text-xs text-destructive">
                    {agent.error}
                  </p>
                )}
              </div>
            </li>
          ))}
          {a2aMembers.map((member) => (
            <RoomA2aMember
              key={member.id}
              member={member}
              canManage={!!room.canManageMembers}
              onEdit={() => onEditA2a(member)}
              onUpdated={onA2aUpdated}
              onRemoved={onA2aRemoved}
              onMention={() => onMention(member)}
            />
          ))}
          {room.memberIds.map((id) => {
            const profile = profiles.get(id);
            const name =
              profile?.name ||
              profile?.username ||
              t('groupChat.unknownMember');
            return (
              <li key={id} className="flex items-center gap-3 py-4">
                <MemberAvatar member={profile} label={name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={name}>
                    {name}
                  </p>
                  {profile?.username && (
                    <p className="truncate text-xs text-muted-foreground">
                      @{profile.username}
                    </p>
                  )}
                </div>
                <Badge variant={id === userId ? 'secondary' : 'outline'}>
                  {t(id === userId ? 'groupChat.you' : 'groupChat.memberRole')}
                </Badge>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </section>
  );
}
