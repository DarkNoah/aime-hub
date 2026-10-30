import { useEffect, useState } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import type { GroupChatDetail } from '@aime/shared/group-chats';
import { useTranslation } from 'react-i18next';
import { useAuthSession } from '@/features/auth/session-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { groupChatApi, groupChatErrorKey, type GroupChatErrorKey } from './api';
import { RoomPanel } from './components/room-panel';
import { RoomSwitcher } from './components/room-switcher';

export function GroupChatsPage() {
  const { projectId } = useParams({ strict: false });
  const { roomId } = useSearch({ strict: false });
  const { data } = useAuthSession();
  if (!data) return null;
  return (
    <DefaultRoom
      key={`${data.user.id}:${projectId ?? 'personal'}:${projectId ? 'default' : (roomId ?? 'default')}`}
      projectId={projectId}
      userId={data.user.id}
      requestedRoomId={projectId ? undefined : roomId}
    />
  );
}

function DefaultRoom({
  projectId,
  userId,
  requestedRoomId,
}: {
  projectId?: string;
  userId: string;
  requestedRoomId?: string;
}) {
  const { t } = useTranslation();
  const [room, setRoom] = useState<GroupChatDetail | null>(null);
  const [error, setError] = useState<GroupChatErrorKey | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (
      requestedRoomId
        ? groupChatApi.get(requestedRoomId, controller.signal)
        : groupChatApi.openDefault(projectId, controller.signal)
    )
      .then((room) => {
        if (!controller.signal.aborted) setRoom(room);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(groupChatErrorKey(cause));
      });
    return () => controller.abort();
  }, [projectId, requestedRoomId, revision]);

  return (
    <div className="flex h-full min-h-0 min-w-0">
      {error ? (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-4 p-6"
        >
          <p>{t(error)}</p>
          <Button
            onClick={() => {
              setError(null);
              setRevision((value) => value + 1);
            }}
          >
            {t('chat.retry')}
          </Button>
        </div>
      ) : room ? (
        <RoomPanel
          key={room.id}
          roomId={room.id}
          projectId={projectId}
          userId={userId}
          roomSwitcher={
            !projectId ? (
              <RoomSwitcher current={room} userId={userId} />
            ) : undefined
          }
        />
      ) : (
        <div
          className="flex flex-1 flex-col gap-6 p-6"
          aria-label={t('chat.loading')}
        >
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-16 w-2/3" />
          <Skeleton className="ml-auto h-16 w-1/2" />
        </div>
      )}
    </div>
  );
}
