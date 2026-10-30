import { useEffect, useState, type ReactNode } from 'react';
import { useAuthSession } from '@/features/auth/session-context';
import { apiErrorCode } from '@/lib/rpc';
import { groupChatApi } from './api';
import { RoomUnreadContext } from './unread-context';
import { createRoomUnreadResource } from './unread-resource';

export function RoomUnreadProvider({ children }: { children: ReactNode }) {
  const sessionId = useAuthSession().data?.session.id;
  const [resource] = useState(() =>
    createRoomUnreadResource(groupChatApi.markRead),
  );
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    async function refresh() {
      if (busy || controller.signal.aborted) return;
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const result = await groupChatApi.unread(controller.signal);
        if (!controller.signal.aborted) resource.receive(result.rooms);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          ['UNAUTHORIZED', 'FORBIDDEN'].includes(apiErrorCode(error) ?? '')
        )
          resource.reset();
      } finally {
        busy = false;
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 2500);
      }
    }
    const wake = () => void refresh();
    wake();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      resource.reset();
    };
  }, [resource, sessionId]);
  return (
    <RoomUnreadContext.Provider value={resource}>
      {children}
    </RoomUnreadContext.Provider>
  );
}
