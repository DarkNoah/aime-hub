import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThreadNavigationEvent } from '@aime/shared/threads';
import { ThreadListContext } from './use-thread-list';
import { useProjectNavigation } from '@/pages/projects/use-project-navigation';
import { createThreadNavigationResource } from './thread-navigation-resource';
import { ThreadNavigationContext } from './thread-navigation-context';
import { useAuthSession } from '@/features/auth/session-context';
import { SharedEventSource } from '@/components/realtime/event-source';

export function ThreadNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const personal = useContext(ThreadListContext);
  const sessionId = useAuthSession().data?.session.id;
  const projects = useProjectNavigation();
  if (!personal) throw new Error('ThreadListProvider is required');
  const [resource] = useState(() =>
    createThreadNavigationResource(personal, projects),
  );
  useEffect(() => {
    if (!sessionId) return;
    const source = new SharedEventSource('/api/threads/events', sessionId);
    source.addEventListener('navigation', (event) => {
      resource.receive(
        JSON.parse((event as MessageEvent).data) as ThreadNavigationEvent,
      );
    });
    source.addEventListener('expired', () => {
      source.close();
      resource.receive({
        type: 'snapshot',
        threads: [],
        projects: [],
        archivedThreads: [],
      });
    });
    // EventSource retries transport failures; every connection starts with a fresh snapshot.
    return () => {
      source.close();
      resource.cancel();
    };
  }, [resource, sessionId]);
  return (
    <ThreadNavigationContext.Provider value={resource}>
      {children}
    </ThreadNavigationContext.Provider>
  );
}
