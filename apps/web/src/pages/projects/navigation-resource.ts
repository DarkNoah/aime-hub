import type { ProjectSummary } from '@aime/shared/projects';
import type { ThreadSummary } from '@aime/shared/threads';
import { chatApi, chatErrorKey } from '../../components/chat/api.js';
import { createThreadListResource } from '../../components/chat/thread-list-resource.js';
import { projectApi } from './api.js';

type Snapshot = {
  projects: ProjectSummary[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: ReturnType<typeof chatErrorKey> | null;
};

export function createProjectListResource(loadPage = projectApi.list) {
  let liveProjects: ProjectSummary[] | undefined;
  let snapshot: Snapshot = {
    projects: [],
    page: -1,
    hasMore: true,
    loading: false,
    error: null,
  };
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const removed = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  function loadMore(): Promise<void> {
    if (!snapshot.hasMore) return Promise.resolve();
    if (liveProjects) {
      const size = snapshot.projects.length + 5;
      publish({
        ...snapshot,
        projects: liveProjects.slice(0, size),
        page: snapshot.page + 1,
        hasMore: liveProjects.length > size,
        loading: false,
        error: null,
      });
      return Promise.resolve();
    }
    if (pending) return pending;
    controller = new AbortController();
    const signal = controller.signal;
    const page = snapshot.page + 1;
    publish({ ...snapshot, loading: true, error: null });
    pending = (async () => {
      try {
        const result = await loadPage(page, signal, 5);
        if (signal.aborted) return;
        const known = new Set(snapshot.projects.map((project) => project.id));
        publish({
          projects: [
            ...snapshot.projects,
            ...result.projects.filter(
              (project) => !known.has(project.id) && !removed.has(project.id),
            ),
          ],
          page: result.page,
          hasMore: result.hasMore,
          loading: false,
          error: null,
        });
      } catch (cause) {
        if (!signal.aborted)
          publish({ ...snapshot, loading: false, error: chatErrorKey(cause) });
      } finally {
        if (!signal.aborted) pending = undefined;
      }
    })();
    return pending;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadMore,
    synchronize(projects: ProjectSummary[]) {
      controller?.abort();
      pending = undefined;
      removed.clear();
      const incoming = new Map(
        projects.map((project) => [project.id, project]),
      );
      const previous = liveProjects ?? snapshot.projects;
      const known = new Set(previous.map((project) => project.id));
      liveProjects = liveProjects
        ? [
            ...projects.filter((project) => !known.has(project.id)),
            ...previous.flatMap((project) =>
              incoming.has(project.id) ? [incoming.get(project.id)!] : [],
            ),
          ]
        : [...projects].sort(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) ||
              b.id.localeCompare(a.id),
          );
      const size = Math.max(5, snapshot.projects.length);
      publish({
        ...snapshot,
        projects: liveProjects.slice(0, size),
        page: Math.max(0, snapshot.page),
        hasMore: liveProjects.length > size,
        loading: false,
        error: null,
      });
    },
    update(project: ProjectSummary) {
      removed.delete(project.id);
      if (liveProjects)
        liveProjects = liveProjects.some((item) => item.id === project.id)
          ? liveProjects.map((item) =>
              item.id === project.id ? project : item,
            )
          : [project, ...liveProjects];
      publish({
        ...snapshot,
        projects: snapshot.projects.some((item) => item.id === project.id)
          ? snapshot.projects.map((item) =>
              item.id === project.id ? project : item,
            )
          : [project, ...snapshot.projects],
      });
    },
    remove(id: string) {
      removed.add(id);
      if (liveProjects)
        liveProjects = liveProjects.filter((project) => project.id !== id);
      publish({
        ...snapshot,
        projects: snapshot.projects.filter((item) => item.id !== id),
      });
    },
    cancel() {
      controller?.abort();
      pending = undefined;
      publish({ ...snapshot, loading: false });
    },
  };
}

// One cache per signed-in session, shared by desktop/mobile navigation and pages.
// Thread lists stay lazy: creating a cache does not fetch its first page.
export function createProjectNavigationResource(
  loadProjects = projectApi.list,
  loadThreads = chatApi.list,
) {
  const projects = createProjectListResource(loadProjects);
  let liveThreads: ThreadSummary[] | undefined;
  const threads = new Map<
    string,
    ReturnType<typeof createThreadListResource>
  >();
  return {
    projects,
    threads(projectId: string) {
      let resource = threads.get(projectId);
      if (!resource) {
        resource = createThreadListResource(
          (page, signal) => loadThreads(page, signal, projectId, 5),
          5,
        );
        if (liveThreads)
          resource.synchronize(
            liveThreads.filter((thread) => thread.projectId === projectId),
          );
        threads.set(projectId, resource);
      }
      return resource;
    },
    synchronize(nextProjects: ProjectSummary[], nextThreads: ThreadSummary[]) {
      liveThreads = nextThreads;
      projects.synchronize(nextProjects);
      const allowed = new Set(nextProjects.map((project) => project.id));
      threads.forEach((resource, id) => {
        resource.synchronize(
          allowed.has(id)
            ? nextThreads.filter((thread) => thread.projectId === id)
            : [],
        );
      });
    },
    updateThread(thread: ThreadSummary) {
      if (!thread.projectId) return;
      if (liveThreads)
        liveThreads = [
          ...liveThreads.filter((item) => item.id !== thread.id),
          thread,
        ];
      threads.get(thread.projectId)?.update(thread, true);
    },
    removeThread(id: string, projectId: string) {
      if (liveThreads)
        liveThreads = liveThreads.filter((thread) => thread.id !== id);
      threads.get(projectId)?.remove(id);
    },
    removeProject(id: string) {
      if (liveThreads)
        liveThreads = liveThreads.filter((thread) => thread.projectId !== id);
      threads.get(id)?.synchronize([]);
      projects.remove(id);
      threads.get(id)?.cancel();
      threads.delete(id);
    },
    cancel() {
      projects.cancel();
      threads.forEach((resource) => resource.cancel());
    },
  };
}
