import { useState } from 'react';
import { Settings2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { GroupChatA2AMember } from '@aime/shared/group-chats';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { groupChatApi, groupChatErrorKey } from '../api';
import { RoomAgentAvatar } from './room-agent-avatar';

export function RoomA2aMember({
  member,
  canManage,
  onEdit,
  onUpdated,
  onRemoved,
  onMention,
}: {
  member: GroupChatA2AMember;
  canManage: boolean;
  onEdit: () => void;
  onUpdated: (member: GroupChatA2AMember) => void;
  onRemoved: (memberId: string) => void;
  onMention: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  async function remove() {
    if (pending) return;
    setPending(true);
    try {
      await groupChatApi.removeA2aMember(member.roomId, member.id);
      onRemoved(member.id);
      toast.success(t('groupChat.a2a.deleted'));
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }
  async function toggle(enabled: boolean) {
    if (pending || member.revokedAt) return;
    setPending(true);
    try {
      onUpdated(
        await groupChatApi.updateA2aMember(member.roomId, member.id, {
          enabled,
        }),
      );
      toast.success(t('groupChat.a2a.saved'));
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }
  return (
    <li className="flex gap-3 py-4">
      <RoomAgentAvatar
        name={member.name}
        external
        onMention={member.enabled && !member.revokedAt ? onMention : undefined}
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p
            className="min-w-0 truncate text-sm font-medium"
            title={member.name}
          >
            {member.name}
          </p>
          <Badge variant="outline">A2A</Badge>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge
            variant={
              member.revokedAt
                ? 'destructive'
                : member.enabled
                  ? 'secondary'
                  : 'outline'
            }
          >
            {t(
              member.revokedAt
                ? 'groupChat.a2a.revoked'
                : member.enabled
                  ? 'groupChat.a2a.enabled'
                  : 'groupChat.status.disabled',
            )}
          </Badge>
          {canManage && (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={pending}
                onClick={onEdit}
                aria-label={t('groupChat.configureAgent', {
                  name: member.name,
                })}
                title={t('groupChat.configureAgent', { name: member.name })}
              >
                <Settings2 className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={pending}
                onClick={() => setDeleting(true)}
                aria-label={t('groupChat.a2a.deleteMember', {
                  name: member.name,
                })}
                title={t('groupChat.a2a.deleteMember', { name: member.name })}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
              {!member.revokedAt && (
                <Switch
                  checked={member.enabled}
                  disabled={pending}
                  aria-label={t('groupChat.toggleAgent', { name: member.name })}
                  onCheckedChange={(enabled) => void toggle(enabled)}
                />
              )}
            </div>
          )}
        </div>
        {canManage && (
          <p className="font-mono text-xs text-muted-foreground">
            {member.keyPrefix}…
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {member.lastUsedAt
            ? t('groupChat.a2a.lastUsed', {
                time: new Date(member.lastUsedAt).toLocaleString(i18n.language),
              })
            : t('groupChat.a2a.neverUsed')}
        </p>
      </div>
      {canManage && deleting && (
        <Dialog
          open
          onOpenChange={(open) => !open && !pending && setDeleting(false)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('groupChat.a2a.deleteTitle')}</DialogTitle>
              <DialogDescription>
                {t('groupChat.a2a.deleteHint', { name: member.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setDeleting(false)}
              >
                {t('agents.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => void remove()}
              >
                {t(
                  pending
                    ? 'groupChat.a2a.deleting'
                    : 'groupChat.a2a.confirmDelete',
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </li>
  );
}
