import { createContext, useContext, useSyncExternalStore } from 'react';
import type {
  createRoomUnreadResource,
  RoomUnreadScope,
} from './unread-resource';

export const RoomUnreadContext = createContext<ReturnType<
  typeof createRoomUnreadResource
> | null>(null);
const emptySubscribe = () => () => {};
export function useRoomUnread(scope: RoomUnreadScope) {
  const resource = useContext(RoomUnreadContext);
  return useSyncExternalStore(
    resource?.subscribe ?? emptySubscribe,
    () => resource?.hasUnread(scope) ?? false,
    () => false,
  );
}
