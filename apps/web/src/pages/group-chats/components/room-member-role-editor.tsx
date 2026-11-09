import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { GroupChatMember } from '@aime/shared/group-chats';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { groupChatApi, groupChatErrorKey } from '../api';

export function RoomMemberRoleEditor({
  roomId,
  projectId,
  member,
  name,
  canEdit,
  onSaved,
  onClose,
}: {
  roomId: string;
  projectId: string | null;
  member: GroupChatMember;
  name: string;
  canEdit: boolean;
  onSaved: (member: GroupChatMember) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [role, setRole] = useState<'admin' | 'member'>(
    member.role === 'admin' ? 'admin' : 'member',
  );
  const [pending, setPending] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !canEdit || role === member.role) return;
    setPending(true);
    try {
      onSaved(await groupChatApi.updateMemberRole(roomId, member.userId, role));
      toast.success(t('groupChat.memberRoleSaved'));
      onClose();
    } catch (cause) {
      toast.error(t(groupChatErrorKey(cause)));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('groupChat.editMemberRole', { name })}</DialogTitle>
          <DialogDescription>
            {t(
              projectId
                ? 'groupChat.projectMemberRoleHint'
                : 'groupChat.memberRoleHint',
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-6" onSubmit={(event) => void save(event)}>
          <Select
            value={role}
            disabled={pending || !canEdit}
            onValueChange={(value: 'admin' | 'member') => setRole(value)}
          >
            <SelectTrigger
              className="w-full"
              aria-label={t('groupChat.editMemberRole', { name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">{t('groupChat.role.admin')}</SelectItem>
              <SelectItem value="member">
                {t('groupChat.role.member')}
              </SelectItem>
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('agents.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={pending || !canEdit || role === member.role}
            >
              {t(pending ? 'agents.saving' : 'groupChat.saveMemberRole')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
