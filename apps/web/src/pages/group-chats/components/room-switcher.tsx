import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { GroupChat } from '@aime/shared/group-chats';
import { RoomUnreadDot } from './room-unread-dot';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  groupChatApi,
  groupChatErrorKey,
  type GroupChatErrorKey,
} from '../api';

export function RoomSwitcher({
  current,
  userId,
}: {
  current: GroupChat;
  userId: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [rooms, setRooms] = useState<GroupChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<GroupChatErrorKey | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function refresh() {
      setLoading(true);
      setError(null);
      try {
        const next: GroupChat[] = [];
        let page = 0;
        let more = true;
        while (more && !controller.signal.aborted) {
          const result = await groupChatApi.list(page++, controller.signal);
          if (controller.signal.aborted) return;
          next.push(...result.rooms);
          setRooms([...next]);
          more = result.hasMore;
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(groupChatErrorKey(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void refresh();
    return () => controller.abort();
  }, [open]);
  const label = (room: GroupChat) =>
    room.createdBy === userId
      ? t('groupChat.myRoom')
      : [room.title, room.ownerName].filter(Boolean).join(' · ');
  const options = rooms.some((room) => room.id === current.id)
    ? rooms
    : [current, ...rooms];
  return (
    <Select
      value={current.id}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(roomId) =>
        void navigate({ to: '/group-chats', search: { roomId } })
      }
    >
      <SelectTrigger
        aria-label={t('groupChat.switchRoom')}
        className="h-7 w-fit max-w-full gap-1 border-0 bg-transparent px-0 text-sm font-semibold shadow-none dark:bg-transparent"
      >
        <SelectValue>{label(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="max-w-[calc(100vw-2rem)]">
        {options.map((room) => (
          <SelectItem key={room.id} value={room.id}>
            <span className="block max-w-64 truncate">{label(room)}</span>
            <RoomUnreadDot roomId={room.id} />
          </SelectItem>
        ))}
        {loading && (
          <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
            {t('chat.loading')}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="max-w-64 px-2 py-2 text-xs text-destructive"
          >
            {t(error)}
          </p>
        )}
      </SelectContent>
    </Select>
  );
}
