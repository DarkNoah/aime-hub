import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useAuthSession } from '@/features/auth/session-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { groupChatApi, groupChatErrorKey, type GroupChatErrorKey } from './api';
import { RoomPanel } from './components/room-panel';

export function GroupChatsPage() {
  const { projectId } = useParams({ strict: false });
  const { data } = useAuthSession();
  if (!data) return null;
  return (
    <DefaultRoom
      key={`${data.user.id}:${projectId ?? 'personal'}`}
      projectId={projectId}
      userId={data.user.id}
    />
  );
}

function DefaultRoom({
  projectId,
  userId,
}: {
  projectId?: string;
  userId: string;
}) {
  const { t } = useTranslation();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [error, setError] = useState<GroupChatErrorKey | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void groupChatApi
      .openDefault(projectId, controller.signal)
      .then((room) => {
        if (!controller.signal.aborted) setRoomId(room.id);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(groupChatErrorKey(cause));
      });
    return () => controller.abort();
  }, [projectId, revision]);

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
      ) : roomId ? (
        <RoomPanel
          key={roomId}
          roomId={roomId}
          projectId={projectId}
          userId={userId}
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
