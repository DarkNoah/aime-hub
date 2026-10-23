import { isThreadActive } from '@aime/shared/threads';
import type {
  ThreadNavigationEvent,
  ThreadSummary,
} from '@aime/shared/threads';
import { createThreadListResource } from './thread-list-resource.js';
import { chatApi } from './api.js';
import type { createProjectNavigationResource } from '../../pages/projects/navigation-resource.js';

export function createThreadNavigationResource(
  personal: ReturnType<typeof createThreadListResource>,
  projects: ReturnType<typeof createProjectNavigationResource>,
) {
  const threads = new Map<string, ThreadSummary>();
  const pluginLists = new Map<
    string,
    ReturnType<typeof createThreadListResource>
  >();
  let synchronized = false;
  const listeners = new Set<() => void>();
  let archivedThreads: ThreadSummary[] | undefined;
  const removeArchived = (id: string) => {
    if (archivedThreads?.some((thread) => thread.id === id))
      archivedThreads = archivedThreads.filter((thread) => thread.id !== id);
  };
  let counts = new Map<string, number>();
  return {
    /** Personal plugin chats share the global feed but keep independent pagination. */
    pluginThreads(plugin: string) {
      let list = pluginLists.get(plugin);
      if (!list) {
        list = createThreadListResource(
          (page, signal) => chatApi.list(page, signal, undefined, 5, plugin),
          5,
          plugin,
        );
        if (synchronized)
          list.synchronize(
            [...threads.values()].filter((thread) => !thread.projectId),
          );
        pluginLists.set(plugin, list);
      }
      return list;
    },
    cancel() {
      pluginLists.forEach((list) => list.cancel());
    },
    getArchivedThreads: () => archivedThreads,
    removeArchivedThread(id: string) {
      removeArchived(id);
      listeners.forEach((listener) => listener());
    },
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
          synchronized = true;
          archivedThreads = event.archivedThreads;
          threads.clear();
          event.threads.forEach((thread) => threads.set(thread.id, thread));
          personal.synchronize(
            event.threads.filter((thread) => !thread.projectId),
          );
          pluginLists.forEach((list) =>
            list.synchronize(
              event.threads.filter((thread) => !thread.projectId),
            ),
          );
          projects.synchronize(
            event.projects,
            event.threads.filter((thread) => !!thread.projectId),
          );
          break;
        case 'upsert':
          removeArchived(event.thread.id);
          threads.set(event.thread.id, event.thread);
          if (event.thread.projectId) projects.updateThread(event.thread);
          else {
            personal.update(event.thread, true);
            pluginLists.forEach((list) => list.update(event.thread, true));
          }
          break;
        case 'remove':
          removeArchived(event.id);
          if (event.archivedThread)
            archivedThreads = [
              event.archivedThread,
              ...(archivedThreads ?? []),
            ];
          threads.delete(event.id);
          if (event.projectId) projects.removeThread(event.id, event.projectId);
          else {
            personal.remove(event.id);
            pluginLists.forEach((list) => list.remove(event.id));
          }
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
        if (
          thread.projectId &&
          thread.plugin === undefined &&
          isThreadActive(thread.status)
        )
          counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
      }
      listeners.forEach((listener) => listener());
    },
  };
}
