import { createContext, useContext, useSyncExternalStore } from 'react';
import type { createThreadListResource } from './thread-list-resource';
import { ThreadNavigationContext } from './thread-navigation-context';

export type ThreadListResource = ReturnType<typeof createThreadListResource>;
export const ThreadListContext = createContext<ThreadListResource | null>(null);

/** Omit plugin for personal chats without a plugin, or supply an explicit resource. */
export function useThreadListResource(
  plugin?: string,
  resource?: ThreadListResource,
) {
  const personal = useContext(ThreadListContext);
  const navigation = useContext(ThreadNavigationContext);
  if (resource) return resource;
  if (plugin !== undefined) {
    if (!navigation) throw new Error('ThreadNavigationProvider is required');
    return navigation.pluginThreads(plugin);
  }
  if (!personal) throw new Error('ThreadListProvider is required');
  return personal;
}

export function useThreadList(plugin?: string) {
  const resource = useThreadListResource(plugin);
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
