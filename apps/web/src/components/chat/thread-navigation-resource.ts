import type {
  ThreadNavigationEvent,
  ThreadSummary,
} from '@aime/shared/threads';
import type { createThreadListResource } from './thread-list-resource.js';
import type { createProjectNavigationResource } from '../../pages/projects/navigation-resource.js';

export function createThreadNavigationResource(
  personal: ReturnType<typeof createThreadListResource>,
  projects: ReturnType<typeof createProjectNavigationResource>,
) {
  const threads = new Map<string, ThreadSummary>();
  const listeners = new Set<() => void>();
  let counts = new Map<string, number>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    runningCount(projectId: string) {
      return counts.get(projectId) ?? 0;
    },
    receive(event: ThreadNavigationEvent) {
      switch (event.type) {
        case 'snapshot':
          threads.clear();
          event.threads.forEach((thread) => threads.set(thread.id, thread));
          personal.synchronize(
            event.threads.filter((thread) => !thread.projectId),
          );
          projects.synchronize(
            event.projects,
            event.threads.filter((thread) => !!thread.projectId),
          );
          break;
        case 'upsert':
          threads.set(event.thread.id, event.thread);
          if (event.thread.projectId) projects.updateThread(event.thread);
          else personal.update(event.thread, true);
          break;
        case 'remove':
          threads.delete(event.id);
          if (event.projectId) projects.removeThread(event.id, event.projectId);
          else personal.remove(event.id);
          break;
        case 'project-removed':
          for (const [id, thread] of threads) {
            if (thread.projectId === event.projectId) threads.delete(id);
          }
          projects.removeProject(event.projectId);
          break;
      }
      counts = new Map();
      for (const thread of threads.values()) {
        // Stopping still owns execution until the runner acknowledges cancellation.
        if (
          thread.projectId &&
          (thread.status === 'running' || thread.status === 'stopping')
        )
          counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
      }
      listeners.forEach((listener) => listener());
    },
  };
}
