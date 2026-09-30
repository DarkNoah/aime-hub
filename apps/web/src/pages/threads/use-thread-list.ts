import { createContext, useContext, useSyncExternalStore } from 'react';
import type { createThreadListResource } from './list-resource';

export const ThreadListContext = createContext<ReturnType<
  typeof createThreadListResource
> | null>(null);

export function useThreadList() {
  const resource = useContext(ThreadListContext);
  if (!resource) throw new Error('ThreadListProvider is required');
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  return {
    ...snapshot,
    loadMore: resource.loadMore,
    updateThread: resource.update,
    removeThread: resource.remove,
  };
}
