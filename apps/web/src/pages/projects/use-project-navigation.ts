import { createContext, useContext } from 'react';
import type { createProjectNavigationResource } from './navigation-resource';

export const ProjectNavigationContext = createContext<ReturnType<
  typeof createProjectNavigationResource
> | null>(null);

export function useProjectNavigation() {
  const resource = useContext(ProjectNavigationContext);
  if (!resource) throw new Error('ProjectNavigationProvider is required');
  return resource;
}
