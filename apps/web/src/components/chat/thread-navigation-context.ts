import { createContext, useContext, useSyncExternalStore } from 'react';
import type { createThreadNavigationResource } from './thread-navigation-resource';

export const ThreadNavigationContext = createContext<ReturnType<
  typeof createThreadNavigationResource
> | null>(null);

export function useProjectRunningCount(projectId: string) {
  const resource = useContext(ThreadNavigationContext);
  if (!resource) throw new Error('ThreadNavigationProvider is required');
  return useSyncExternalStore(
    resource.subscribe,
    () => resource.runningCount(projectId),
    () => 0,
  );
}
