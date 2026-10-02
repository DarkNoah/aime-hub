import { useEffect, useState, type ReactNode } from 'react';
import { createProjectNavigationResource } from './navigation-resource';
import { ProjectNavigationContext } from './use-project-navigation';

export function ProjectNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [resource] = useState(createProjectNavigationResource);
  useEffect(() => {
    if (resource.projects.getSnapshot().page < 0)
      void resource.projects.loadMore();
    return () => resource.cancel();
  }, [resource]);
  return (
    <ProjectNavigationContext.Provider value={resource}>
      {children}
    </ProjectNavigationContext.Provider>
  );
}
