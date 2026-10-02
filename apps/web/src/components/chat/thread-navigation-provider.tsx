import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThreadNavigationEvent } from '@aime/shared/threads';
import { ThreadListContext } from '@/pages/threads/use-thread-list';
import { useProjectNavigation } from '@/pages/projects/use-project-navigation';
import { createThreadNavigationResource } from './thread-navigation-resource';
import { ThreadNavigationContext } from './thread-navigation-context';

export function ThreadNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const personal = useContext(ThreadListContext);
  const projects = useProjectNavigation();
  if (!personal) throw new Error('ThreadListProvider is required');
  const [resource] = useState(() =>
    createThreadNavigationResource(personal, projects),
  );
  useEffect(() => {
    const source = new EventSource('/api/threads/events');
    source.addEventListener('navigation', (event) => {
      resource.receive(
        JSON.parse((event as MessageEvent).data) as ThreadNavigationEvent,
      );
    });
    source.addEventListener('expired', () => {
      source.close();
      resource.receive({ type: 'snapshot', threads: [], projects: [] });
    });
    // EventSource retries transport failures; every connection starts with a fresh snapshot.
    return () => source.close();
  }, [resource]);
  return (
    <ThreadNavigationContext.Provider value={resource}>
      {children}
    </ThreadNavigationContext.Provider>
  );
}
