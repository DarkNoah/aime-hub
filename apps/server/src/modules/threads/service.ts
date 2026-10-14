import { nanoid } from 'nanoid';
import type {
  ChatSession,
  ChatSessionContext,
  ChatSessionEvent,
} from './session.js';
import { threadMessages } from './message-conversion.js';
import type { Memory } from '@mastra/memory';
import type { StorageThreadType } from '@mastra/core/memory';
import type { WorkspaceFilesystem } from '@mastra/core/workspace';
import type { FileScope } from '@aime/shared/files';
import type { UIMessage } from 'ai';
import {
  canContinueThread,
  mergeThreadMessages,
  threadMessageSourceIds,
} from '@aime/shared/thread-messages';
import type {
  ChatSettings,
  QueuedMessage,
  UpdateQueuedMessage,
  ChatSkill,
  MessagePage,
  RunInput,
  ThreadSnapshot,
  ThreadSummary,
  ThreadNavigationEvent,
  ChatUsage,
  ToolInteraction,
  ToolResponse,
  ThreadStatus,
  ThreadBackgroundTask,
  ThreadGoal,
} from '@aime/shared/threads';
import {
  toolResponseSchema,
  runInputSchema,
  threadStreamStatusSchema,
} from '@aime/shared/threads';
import type { ProjectSummary } from '@aime/shared/projects';
import { ThreadError, threadErrorMessage } from './errors.js';
import {
  resolveFileReference,
  validateFileReference,
} from '../files/reference.js';
import type { ProjectThreadAccess } from '../projects/service.js';
import { threadScope } from './scope.js';
import { ThreadNavigationFeed } from './navigation-feed.js';
import { validateToolResponse } from './tool-interactions.js';
import {
  ThreadBackgroundTasks,
  isBackgroundTaskActive,
  type ThreadBackgroundTaskManager,
} from './background-tasks.js';

type Subscription = {
  userId: string;
  active: boolean;
  listener: (snapshot: ThreadSnapshot<UIMessage>, initial: boolean) => void;
  revoked?: (code?: string) => void;
  pending: Promise<void>;
};

type ThreadData = {
  status: ThreadStatus;
  activeId: string | null;
  acceptedIds: string[];
  reasoningEffort: ChatSettings['reasoningEffort'];
  error: string | null;
  autoTitle: boolean;
  usage: ChatUsage | null;
  toolInteractions: (ToolInteraction & { settings: ChatSettings })[];
};
type Runtime = {
  thread: StorageThreadType;
  data: ThreadData;
  goal: ThreadGoal | null;
  messages: UIMessage[];
  changedMessages: Map<string, UIMessage>;
  removedMessageIds: Set<string>;
  activeMessageId: string | null;
  session?: ChatSession;
  sessionKey?: string;
  titleGeneration?: symbol;
  queueCount: number;
  queuedMessages: QueuedMessage[];
  listeners: Set<Subscription>;
  expiry?: ReturnType<typeof setTimeout>;
  broadcast?: ReturnType<typeof setTimeout>;
  navigationSignature?: string;
  backgroundTasks: ThreadBackgroundTask[];
  backgroundObserver?: ThreadBackgroundTasks;
  backgroundTasksError: 'BACKGROUND_TASKS_UNAVAILABLE' | null;
};

export interface ChatRunner {
  resolveSettings?(settings: ChatSettings): Promise<ChatSettings>;
  sessionKey?(settings: ChatSettings): Promise<string>;
  getGoal?(threadId: string): Promise<ThreadGoal | null>;
  clearGoal?(threadId: string): Promise<void>;
  projectFilesystem?(
    userId: string,
    projectId: string,
  ): Promise<WorkspaceFilesystem>;
  listSkills?(userId: string, projectId?: string): Promise<ChatSkill[]>;
  personalSharedDirectory?(userId: string): Promise<string>;
  validate(
    userId: string,
    input: RunInput | ChatSettings,
    projectId?: string,
  ): Promise<void>;
  createWorkspace(userId: string, projectId?: string): Promise<string>;
  removePersonalWorkspace?(userId: string, directory: string): Promise<void>;
  open(context: ChatSessionContext): Promise<ChatSession>;
}

type ThreadMemory = Pick<
  Memory,
  | 'createThread'
  | 'getThreadById'
  | 'updateThread'
  | 'listThreads'
  | 'recall'
  | 'saveMessages'
  | 'deleteThread'
>;
const PAGE_SIZE = 40;
const isChatThread = (thread: StorageThreadType) =>
  !Object.hasOwn(thread.metadata ?? {}, 'goalJudge') &&
  (!thread.metadata?.automation ||
    (thread.metadata.automation as { visible?: boolean }).visible === true);
const isArchived = (thread: StorageThreadType) =>
  typeof thread.metadata?.archivedAt === 'string';
const initialData = (): ThreadData => ({
  status: 'idle',
  activeId: null,
  acceptedIds: [],
  reasoningEffort: 'auto',
  error: null,
  autoTitle: true,
  usage: null,
  toolInteractions: [],
});
function dataOf(thread: StorageThreadType): ThreadData {
  const defaults = initialData();
  const metadata: Record<string, unknown> = {
    ...defaults,
    // Read old threads until their next access migrates them to top-level fields.
    ...(thread.metadata?.aime as Partial<ThreadData> | undefined),
    ...thread.metadata,
  };
  // Only retain our runtime fields; Mastra/OM metadata must not be replayed on save.
  const data = Object.fromEntries(
    Object.keys(defaults).map((key) => [key, metadata[key]]),
  ) as ThreadData;
  // Threads created before stream statuses were persisted retain recoverable HITL state.
  if (thread.metadata?.status === undefined) {
    data.status = data.error
      ? 'failed'
      : data.toolInteractions.some((item) => !item.response)
        ? 'suspended'
        : 'idle';
  } else if (data.status !== 'idle') {
    data.status =
      threadStreamStatusSchema.safeParse(data.status).data ?? 'failed';
  }
  // Older stream adapters persisted tool errors even after a successful run.
  if (data.status === 'success') data.error = null;
  return data;
}
const messageText = (input: RunInput) =>
  input.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

// One process owns execution; subscribers only observe it. Closing a browser never aborts a run.
export class ThreadService {
  private navigation = new ThreadNavigationFeed(
    (userId) => this.navigationSnapshot(userId),
    (userId, projectId) => this.projectAccess(userId, projectId),
  );
  private runtimes = new Map<string, Runtime>();
  private locks = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(
    private memory: ThreadMemory,
    private runner: ChatRunner,
    private projects?: ProjectThreadAccess,
    private backgroundTaskManager?: ThreadBackgroundTaskManager,
    private isSystemAdmin: (userId: string) => Promise<boolean> = async () =>
      false,
  ) {}

  subscribeNavigation(
    userId: string,
    send: (event: ThreadNavigationEvent) => void,
    close: () => void,
  ) {
    return this.navigation.subscribe(userId, send, close);
  }

  refreshNavigation(userId?: string) {
    this.navigation.refresh(userId);
  }

  /** Reuse chat snapshots for messages persisted by a native scheduled Agent. */
  async refreshAutomationThread(
    userId: string,
    id: string,
    event?: ChatSessionEvent,
  ) {
    const runtime = await this.runtime(userId, id);
    await this.locked(id, async () => {
      runtime.thread = (await this.memory.getThreadById({ threadId: id }))!;
      runtime.data.reasoningEffort = dataOf(runtime.thread).reasoningEffort;
      const history = await this.history(userId, id);
      for (const message of history.messages) this.upsert(runtime, message);
      this.publish(runtime);
    });
    if (event) await this.observe(runtime, event);
    this.refreshNavigation();
  }

  private async listChatThreads(resourceId: string, archived = false) {
    const result = await this.memory.listThreads({
      filter: { resourceId },
      page: 0,
      perPage: false,
      orderBy: { field: 'updatedAt', direction: 'DESC' },
    });
    return result.threads.filter(
      (thread) => isChatThread(thread) && isArchived(thread) === archived,
    );
  }

  private async navigationSnapshot(
    userId: string,
  ): Promise<ThreadNavigationEvent> {
    const projects: ProjectSummary[] = [];
    if (this.projects?.list) {
      for (let page = 0; ; page++) {
        const result = await this.projects.list(userId, page, 100, 'all');
        projects.push(...result.projects);
        if (!result.hasMore) break;
      }
    }
    const threads = new Map<string, ThreadSummary>();
    if (await this.isSystemAdmin(userId)) {
      for (const thread of await this.listChatThreads('system:automations'))
        threads.set(
          thread.id,
          this.summary(thread, this.runtimes.get(thread.id)),
        );
    }
    for (const projectId of [
      undefined,
      ...projects.map((project) => project.id),
    ]) {
      const chatThreads = await this.listChatThreads(
        projectId ? `project:${projectId}` : `user:${userId}`,
      );
      for (const thread of chatThreads)
        threads.set(
          thread.id,
          this.summary(thread, this.runtimes.get(thread.id)),
        );
    }
    // Recheck membership after reading the summaries, before releasing the snapshot.
    const visible: ProjectSummary[] = [];
    for (const project of projects) {
      try {
        const { role } = await this.projectAccess(userId, project.id);
        visible.push({ ...project, role });
      } catch (error) {
        if (!(error instanceof ThreadError) || error.status !== 404)
          throw error;
      }
    }
    const allowed = new Set(visible.map((project) => project.id));
    return {
      type: 'snapshot',
      projects: visible,
      archivedThreads: await this.listArchivedThreads(userId),
      threads: [...threads.values()].filter(
        (thread) => !thread.projectId || allowed.has(thread.projectId),
      ),
    };
  }

  private locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.locks.set(id, next);
    void next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  private async accessible(
    userId: string,
    id: string,
    includeArchived = false,
  ) {
    const thread = await this.memory.getThreadById({ threadId: id });
    if (!thread) throw new ThreadError('THREAD_NOT_FOUND', 404);
    const scope = threadScope(thread.resourceId);
    if (scope.type === 'system') {
      if (!(await this.isSystemAdmin(userId)))
        throw new ThreadError('THREAD_NOT_FOUND', 404);
    } else if (scope.type === 'project') {
      await this.projectAccess(userId, scope.projectId);
    } else if (scope.userId !== userId)
      throw new ThreadError('THREAD_NOT_FOUND', 404);
    if (!includeArchived && isArchived(thread))
      throw new ThreadError('THREAD_NOT_FOUND', 404);
    return thread;
  }

  private async projectAccess(userId: string, projectId: string) {
    if (!this.projects) throw new ThreadError('PROJECT_NOT_FOUND', 404);
    return this.projects.assertMember(userId, projectId);
  }

  private async manageable(userId: string, thread: StorageThreadType) {
    const { projectId } = threadScope(thread.resourceId);
    if (projectId) {
      const { role } = await this.projectAccess(userId, projectId);
      if (role === 'member' && thread.metadata?.createdBy !== userId)
        throw new ThreadError('FORBIDDEN', 403);
    }
  }

  private async scopeLocked<T>(
    userId: string,
    id: string,
    action: () => Promise<T>,
    includeArchived = false,
  ) {
    const thread = await this.accessible(userId, id, includeArchived);
    const { projectId } = threadScope(thread.resourceId);
    return projectId
      ? this.locked(`project:${projectId}`, () => this.locked(id, action))
      : this.locked(id, action);
  }

  private summary(thread: StorageThreadType, runtime?: Runtime): ThreadSummary {
    const data = runtime?.data ?? dataOf(thread);
    return {
      id: thread.id,
      projectId: threadScope(thread.resourceId).projectId ?? null,
      createdBy:
        typeof thread.metadata?.createdBy === 'string'
          ? thread.metadata.createdBy
          : undefined,
      title: thread.title ?? '',
      agentId:
        typeof thread.metadata?.agentId === 'string'
          ? thread.metadata.agentId
          : null,
      model:
        typeof thread.metadata?.model === 'string'
          ? thread.metadata.model
          : null,
      reasoningEffort: data.reasoningEffort,
      createdAt: new Date(thread.createdAt).toISOString(),
      updatedAt: new Date(thread.updatedAt).toISOString(),
      archivedAt: isArchived(thread)
        ? String(thread.metadata!.archivedAt)
        : null,
      status: data.activeId && !runtime ? 'failed' : data.status,
      error: data.activeId && !runtime ? 'RUN_INTERRUPTED' : data.error,
      queueCount: runtime?.queueCount ?? 0,
      queue: runtime?.queuedMessages ?? [],
    };
  }

  private snapshot(runtime: Runtime): ThreadSnapshot<UIMessage> {
    return {
      thread: this.summary(runtime.thread, runtime),
      messages: runtime.messages,
      activeMessageId: runtime.activeMessageId,
      usage: runtime.data.usage,
      goal: runtime.goal,
      backgroundTasks: runtime.backgroundTasks,
      backgroundTasksError: runtime.backgroundTasksError,
      toolInteractions: runtime.data.toolInteractions.map((item) => ({
        id: item.id,
        kind: item.kind,
        runId: item.runId,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        input: item.input,
        suspendPayload: item.suspendPayload,
        resumeSchema: item.resumeSchema,
        response: item.response,
      })),
    };
  }

  private publish(runtime: Runtime, throttle = false) {
    const send = () => {
      runtime.broadcast = undefined;
      const snapshot = {
        ...this.snapshot(runtime),
        messages: [...runtime.changedMessages.values()],
        removedMessageIds: [...runtime.removedMessageIds],
      };
      runtime.changedMessages.clear();
      runtime.removedMessageIds.clear();
      const signature = JSON.stringify(snapshot.thread);
      if (signature !== runtime.navigationSignature) {
        runtime.navigationSignature = signature;
        if (
          snapshot.thread.error !== 'THREAD_NOT_FOUND' &&
          !isArchived(runtime.thread) &&
          isChatThread(runtime.thread)
        )
          this.navigation.publish(runtime.thread.resourceId!, {
            type: 'upsert',
            thread: snapshot.thread,
          });
      }
      for (const subscription of runtime.listeners)
        void this.deliver(runtime, subscription, snapshot, false);
    };
    if (throttle) {
      runtime.broadcast ??= setTimeout(send, 50);
    } else {
      clearTimeout(runtime.broadcast);
      send();
    }
  }

  private deliver(
    runtime: Runtime,
    subscription: Subscription,
    snapshot: ThreadSnapshot<UIMessage>,
    initial: boolean,
  ) {
    // Serialize authorization and delivery so delayed membership reads cannot reorder SSE events.
    subscription.pending = subscription.pending
      .then(async () => {
        if (!subscription.active) return;
        const { projectId } = threadScope(runtime.thread.resourceId);
        if (projectId) await this.projectAccess(subscription.userId, projectId);
        if (subscription.active) subscription.listener(snapshot, initial);
      })
      .catch(() => {
        subscription.active = false;
        runtime.listeners.delete(subscription);
        subscription.revoked?.();
        this.release(runtime);
      });
    return subscription.pending;
  }

  private release(runtime: Runtime) {
    clearTimeout(runtime.expiry);
    if (
      this.closing ||
      this.busy(runtime) ||
      runtime.listeners.size ||
      runtime.backgroundTasks.some(
        (task) => task.status === 'pending' || task.status === 'running',
      )
    )
      return;
    runtime.expiry = setTimeout(() => {
      if (!this.busy(runtime) && !runtime.listeners.size) {
        void runtime.backgroundObserver?.stop();
        void runtime.session?.close();
        this.runtimes.delete(runtime.thread.id);
      }
    }, 15 * 60_000);
    runtime.expiry.unref();
  }

  private async save(runtime: Runtime) {
    runtime.thread = await this.memory.updateThread({
      id: runtime.thread.id,
      title: runtime.thread.title,
      metadata: {
        // Mastra patchThread merges metadata; do not replay stale Mastra/OM fields from the runtime cache.
        model: runtime.thread.metadata?.model ?? null,
        agentId: runtime.thread.metadata?.agentId ?? null,
        // Preserve pre-migration drafts until the first native session accepts them.
        ...(runtime.thread.metadata?.queue === undefined &&
        runtime.thread.metadata?.aime
          ? {
              queue: (runtime.thread.metadata.aime as Record<string, unknown>)
                .queue,
            }
          : {}),
        ...structuredClone(runtime.data),
        // The Postgres adapter shallow-merges, then JSON-serializes metadata.
        // An undefined legacy key is omitted from the persisted JSON.
        ...(runtime.thread.metadata?.aime !== undefined
          ? { aime: undefined }
          : {}),
      },
    });
  }

  private backgroundFailed(runtime: Runtime, error: unknown) {
    console.error('Thread background task subscription failed', error);
    runtime.backgroundTasksError = 'BACKGROUND_TASKS_UNAVAILABLE';
    this.publish(runtime);
  }

  private busy(runtime: Runtime) {
    return (
      runtime.data.status === 'running' ||
      runtime.data.status === 'pending' ||
      runtime.queueCount > 0
    );
  }

  private observe(runtime: Runtime, event: ChatSessionEvent) {
    // Serialize snapshot/storage updates only. Mastra schedules all model work.
    return this.locked(runtime.thread.id, async () => {
      if (this.runtimes.get(runtime.thread.id) !== runtime) return;
      if (event.type === 'goal') {
        // Read native state after taking the lock. A late event must never
        // restore the objective that the user has just cleared.
        const goal = (await this.runner.getGoal?.(runtime.thread.id)) ?? null;
        runtime.goal =
          goal && event.objective === goal.objective
            ? {
                ...goal,
                evaluating: event.evaluating,
                waitingForUser: event.waitingForUser,
              }
            : goal && goal.id === runtime.goal?.id
              ? { ...runtime.goal, ...goal }
              : goal;
        this.publish(runtime, true);
        return;
      }
      if (event.type === 'reconcile') {
        const removed = new Set(event.removedMessageIds);
        runtime.messages = runtime.messages.filter(
          (message) => !removed.has(message.id),
        );
        for (const id of removed) {
          runtime.changedMessages.delete(id);
          runtime.removedMessageIds.add(id);
        }
        for (const message of event.messages) this.upsert(runtime, message);
        if (runtime.activeMessageId && removed.has(runtime.activeMessageId))
          runtime.activeMessageId = null;
        this.publish(runtime, true);
        return;
      }
      if (event.type === 'message') {
        this.upsert(runtime, event.message);
        if (event.active && runtime.data.activeId)
          runtime.activeMessageId =
            runtime.messages.find((message) =>
              threadMessageSourceIds(message).includes(event.message.id),
            )?.id ?? null;
        this.publish(runtime, true);
        return;
      }
      if (event.type === 'queue') {
        runtime.queueCount = event.count;
        if (event.messages) runtime.queuedMessages = event.messages;
        this.publish(runtime, true);
        this.release(runtime);
        return;
      }
      if (event.type === 'usage') runtime.data.usage = event.usage;
      else if (event.type === 'interaction') {
        const pending = { ...event.interaction, settings: event.settings };
        runtime.data.toolInteractions = [
          ...runtime.data.toolInteractions.filter(
            (item) => item.toolCallId !== pending.toolCallId,
          ),
          pending,
        ].slice(-100);
      } else if (event.type === 'error') {
        if (
          runtime.data.status === 'canceled' ||
          (event.runId &&
            runtime.data.activeId &&
            event.runId !== runtime.data.activeId)
        )
          return;
        runtime.data.error = threadErrorMessage(event.error);
        runtime.data.status = 'failed';
        runtime.data.activeId = null;
        runtime.activeMessageId = null;
      } else if (event.type === 'status') {
        if (event.status === 'running' || event.status === 'pending') {
          runtime.data.activeId = event.runId;
          runtime.data.error = null;
        } else if (
          runtime.data.activeId &&
          runtime.data.activeId !== event.runId
        )
          return;
        runtime.data.status = event.status;
        if (event.status === 'success') runtime.data.error = null;
        if (runtime.goal) {
          runtime.goal.evaluating = false;
          if (event.status === 'running') runtime.goal.waitingForUser = false;
        }
        if (event.status !== 'running' && event.status !== 'pending') {
          runtime.data.activeId = null;
          runtime.activeMessageId = null;
          runtime.messages = runtime.messages.slice(-80);
        }
      }
      await this.save(runtime);
      this.publish(runtime);
      this.release(runtime);
    }).catch((error: unknown) => {
      runtime.data.error = threadErrorMessage(error);
      runtime.data.status = 'failed';
      this.publish(runtime);
    });
  }

  private async session(
    runtime: Runtime,
    settings: ChatSettings,
    handoff = true,
  ) {
    // Tool replies and compaction continue the existing native session, even if
    // its stored configuration has since been edited or removed.
    if (runtime.session && !handoff) return runtime.session;
    const key = await this.runner.sessionKey?.(settings);
    if (runtime.session && key !== runtime.sessionKey) {
      if (
        this.busy(runtime) ||
        runtime.data.toolInteractions.some((item) => !item.response) ||
        runtime.backgroundTasks.some(isBackgroundTaskActive) ||
        runtime.goal?.status === 'active'
      )
        throw new ThreadError('AGENT_CHANGE_BUSY', 409);
      await runtime.session.close();
      runtime.session = undefined;
    }
    if (!runtime.session) {
      runtime.session = await this.runner.open({
        thread: runtime.thread,
        settings,
        onEvent: (event) => this.observe(runtime, event),
      });
      runtime.sessionKey = key;
    }
    // Checkpoint each pre-migration draft only after native acceptance. This is
    // an upgrade handoff; all new input goes directly to the native queue.
    const legacy = runtime.thread.metadata?.queue;
    if (handoff && Array.isArray(legacy)) {
      do {
        const raw = legacy[0];
        const parsed = runInputSchema.safeParse(raw);
        if (legacy.length && parsed.success)
          await runtime.session.send(parsed.data);
        else if (legacy.length && !raw?.resume && !raw?.backgroundTask)
          throw new ThreadError('VALIDATION_ERROR', 400);
        legacy.shift();
        runtime.thread = await this.memory.updateThread({
          id: runtime.thread.id,
          title: runtime.thread.title,
          metadata: {
            queue: legacy.length ? [...legacy] : undefined,
            backgroundContinuations: undefined,
            paused: undefined,
            failedInput: undefined,
          },
        });
      } while (legacy.length);
    }
    return runtime.session;
  }

  private async runtime(userId: string, id: string) {
    const thread = await this.accessible(userId, id);
    const cached = this.runtimes.get(id);
    if (cached) return cached;
    const data = dataOf(thread);
    if (data.activeId) {
      data.activeId = null;
      data.error = 'RUN_INTERRUPTED';
      data.status = 'failed';
    }
    const history = await this.history(userId, id);
    const runtime: Runtime = {
      thread,
      data,
      goal: (await this.runner.getGoal?.(id)) ?? null,
      messages: history.messages,
      changedMessages: new Map(),
      removedMessageIds: new Set(),
      queueCount: 0,
      queuedMessages: [],
      activeMessageId: null,
      listeners: new Set(),
      backgroundTasks: [],
      backgroundTasksError: null,
    };
    if (dataOf(thread).activeId || thread.metadata?.aime !== undefined)
      await this.save(runtime);
    this.runtimes.set(id, runtime);
    if (this.backgroundTaskManager) {
      runtime.backgroundObserver = new ThreadBackgroundTasks(
        this.backgroundTaskManager,
        { threadId: id, resourceId: thread.resourceId! },
        (tasks) => {
          runtime.backgroundTasks = tasks;
          runtime.backgroundTasksError = null;
          this.publish(runtime, true);
          this.release(runtime);
        },
        (error) => this.backgroundFailed(runtime, error),
      );
      try {
        await runtime.backgroundObserver.ready;
      } catch (error) {
        await runtime.backgroundObserver.stop();
        clearTimeout(runtime.broadcast);
        this.runtimes.delete(id);
        throw error;
      }
    }
    this.release(runtime);
    return runtime;
  }

  createThread(
    userId: string,
    input: ChatSettings & { title?: string; projectId?: string },
  ) {
    const create = () => this.create(userId, input);
    return input.projectId
      ? this.locked(`project:${input.projectId}`, create)
      : create();
  }

  private async create(
    userId: string,
    input: ChatSettings & { title?: string; projectId?: string },
  ) {
    if (input.projectId) await this.projectAccess(userId, input.projectId);
    input = { ...input, ...(await this.runner.resolveSettings?.(input)) };
    if (input.model) await this.runner.validate(userId, input, input.projectId);
    const workspace = await this.runner.createWorkspace(
      userId,
      input.projectId,
    );
    const thread = await this.memory.createThread({
      threadId: nanoid(16),
      resourceId: input.projectId
        ? `project:${input.projectId}`
        : `user:${userId}`,
      title: input.title ?? '',
      metadata: {
        model: input.model,
        agentId: input.agentId ?? null,
        createdBy: userId,
        workspace,
        ...initialData(),
        reasoningEffort: input.reasoningEffort,
        autoTitle: !input.title,
      },
    });
    const summary = this.summary(thread);
    this.navigation.publish(thread.resourceId!, {
      type: 'upsert',
      thread: summary,
    });
    return summary;
  }

  async listThreads(
    userId: string,
    page = 0,
    projectId?: string,
    perPage = 10,
  ) {
    if (projectId) await this.projectAccess(userId, projectId);
    const threads = await this.listChatThreads(
      projectId ? `project:${projectId}` : `user:${userId}`,
    );
    if (!projectId && (await this.isSystemAdmin(userId))) {
      threads.push(...(await this.listChatThreads('system:automations')));
      threads.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    }
    // Paginate visible chats so judge threads cannot create short or empty pages.
    const start = page * perPage;
    return {
      threads: threads
        .slice(start, start + perPage)
        .map((thread) => this.summary(thread, this.runtimes.get(thread.id))),
      page,
      hasMore: start + perPage < threads.length,
    };
  }

  getThread(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () =>
      this.snapshot(await this.runtime(userId, id)),
    );
  }

  async listArchivedThreads(userId: string) {
    const threads = await this.listChatThreads(`user:${userId}`, true);
    if (await this.isSystemAdmin(userId))
      threads.push(...(await this.listChatThreads('system:automations', true)));
    return threads
      .map((thread) => this.summary(thread))
      .sort(
        (a, b) =>
          b.archivedAt!.localeCompare(a.archivedAt!) ||
          b.id.localeCompare(a.id),
      );
  }

  restoreThread(userId: string, id: string) {
    return this.locked(id, async () => {
      const thread = await this.archivedPersonalThread(userId, id);
      const restored = await this.memory.updateThread({
        id,
        title: thread.title,
        metadata: { archivedAt: null },
      });
      const summary = this.summary(restored);
      this.navigation.publish(thread.resourceId!, {
        type: 'upsert',
        thread: summary,
      });
      return summary;
    });
  }

  private async archivedPersonalThread(userId: string, id: string) {
    const thread = await this.accessible(userId, id, true);
    if (
      (thread.resourceId !== `user:${userId}` &&
        !(
          thread.resourceId === 'system:automations' &&
          (await this.isSystemAdmin(userId))
        )) ||
      !isChatThread(thread)
    )
      throw new ThreadError('THREAD_NOT_FOUND', 404);
    if (!isArchived(thread)) throw new ThreadError('THREAD_NOT_ARCHIVED', 409);
    return thread;
  }

  deleteArchivedThread(userId: string, id: string) {
    return this.locked(id, async () => {
      const thread = await this.archivedPersonalThread(userId, id);
      await this.assertNoBackgroundTasks(thread);
      const directory = thread.metadata?.workspace;
      if (
        typeof directory !== 'string' ||
        !directory ||
        !this.runner.removePersonalWorkspace
      )
        throw new ThreadError('WORKSPACE_UNAVAILABLE', 409);
      // Keep the archive available for retry if filesystem cleanup fails. Missing
      // directories are harmless when retrying after a failed database deletion.
      await this.runner.removePersonalWorkspace(
        thread.resourceId === 'system:automations' ? 'system' : userId,
        directory,
      );
      await this.memory.deleteThread(id);
      this.navigation.publish(thread.resourceId!, {
        type: 'remove',
        id,
        projectId: null,
      });
    });
  }

  async workspaceDirectory(userId: string, id: string) {
    const thread = await this.accessible(userId, id);
    const path = thread.metadata?.workspace;
    if (typeof path !== 'string' || !path)
      throw new ThreadError('WORKSPACE_UNAVAILABLE', 404);
    return path;
  }

  async resolveWorkspaceFile(userId: string, id: string, path: string) {
    const thread = await this.accessible(userId, id);
    validateFileReference(path);
    const directory = await this.workspaceDirectory(userId, id);
    const target = await this.withWorkspaceFiles(userId, id, (root) =>
      resolveFileReference(root, path, directory, 'thread'),
    );
    if (target) return target;
    if (
      threadScope(thread.resourceId).userId === userId &&
      this.runner.personalSharedDirectory
    ) {
      const shared = await this.withWorkspaceFiles(
        userId,
        id,
        (root) => resolveFileReference(root, path, directory, 'shared'),
        'shared',
      );
      if (shared) return shared;
    }
    throw new ThreadError('FILE_OUTSIDE_WORKSPACE', 403);
  }

  /** Resolve asset access from an authorized thread, never a client resource ID. */
  async assetScope(userId: string, id: string) {
    const thread = await this.accessible(userId, id);
    const { projectId } = threadScope(thread.resourceId);
    const threads = projectId
      ? await this.listChatThreads(thread.resourceId)
      : [thread];
    return {
      resourceId: thread.resourceId,
      threadIds: threads.map((item) => item.id),
    };
  }

  async withWorkspaceFiles<T>(
    userId: string,
    id: string,
    action: (root: string | WorkspaceFilesystem) => Promise<T>,
    scope: FileScope = 'thread',
  ) {
    const thread = await this.accessible(userId, id);
    const { projectId } = threadScope(thread.resourceId);
    if (scope === 'shared') {
      if (threadScope(thread.resourceId).userId !== userId)
        throw new ThreadError('FILE_FORBIDDEN', 403);
      return this.locked(id, async () => {
        await this.accessible(userId, id);
        if (!this.runner.personalSharedDirectory)
          throw new ThreadError('WORKSPACE_UNAVAILABLE', 404);
        return action(await this.runner.personalSharedDirectory(userId));
      });
    }
    if (!projectId)
      return this.locked(id, async () =>
        action(await this.workspaceDirectory(userId, id)),
      );
    if (!this.runner.projectFilesystem)
      return action(await this.workspaceDirectory(userId, id));
    const filesystem = await this.runner.projectFilesystem(userId, projectId);
    try {
      await filesystem.init?.();
      return await action(filesystem);
    } finally {
      await filesystem.destroy?.();
    }
  }

  async listSkills(
    userId: string,
    scope: { threadId?: string; projectId?: string } = {},
  ): Promise<ChatSkill[]> {
    let projectId = scope.projectId;
    if (scope.threadId) {
      const thread = await this.accessible(userId, scope.threadId);
      projectId = threadScope(thread.resourceId).projectId;
    } else if (projectId) {
      await this.projectAccess(userId, projectId);
    }
    const skills = (await this.runner.listSkills?.(userId, projectId)) ?? [];
    // Membership or ownership can change while the filesystem is being read.
    if (scope.threadId) await this.accessible(userId, scope.threadId);
    else if (projectId) await this.projectAccess(userId, projectId);
    return skills;
  }

  async history(
    userId: string,
    id: string,
    page = 0,
    anchor = new Date().toISOString(),
  ): Promise<MessagePage<UIMessage>> {
    const thread = await this.accessible(userId, id);
    const result = await this.memory.recall({
      threadId: id,
      resourceId: thread.resourceId,
      page,
      perPage: PAGE_SIZE,
      filter: { dateRange: { end: new Date(anchor) } },
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });
    const ordered = [...result.messages].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return {
      messages: threadMessages(ordered),
      hasMore: result.hasMore,
      page,
      anchor,
    };
  }

  updateThread(
    userId: string,
    id: string,
    input: Partial<ChatSettings> & { title?: string },
  ) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      await this.manageable(userId, runtime.thread);
      if (input.model || input.agentId)
        await this.runner.validate(
          userId,
          {
            model:
              input.model ??
              (typeof runtime.thread.metadata?.model === 'string'
                ? runtime.thread.metadata.model
                : null),
            agentId:
              input.agentId ??
              (typeof runtime.thread.metadata?.agentId === 'string'
                ? runtime.thread.metadata.agentId
                : null),
            reasoningEffort:
              input.reasoningEffort ?? runtime.data.reasoningEffort,
          },
          threadScope(runtime.thread.resourceId).projectId,
        );
      if (input.title !== undefined) {
        runtime.thread.title = input.title;
        runtime.data.autoTitle = false;
        runtime.titleGeneration = undefined;
      }
      if (input.model !== undefined)
        runtime.thread.metadata = {
          ...runtime.thread.metadata,
          model: input.model,
        };
      if (input.agentId !== undefined)
        runtime.thread.metadata = {
          ...runtime.thread.metadata,
          agentId: input.agentId,
        };
      if (input.reasoningEffort)
        runtime.data.reasoningEffort = input.reasoningEffort;
      await this.save(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  run(userId: string, id: string, input: RunInput) {
    return this.scopeLocked(userId, id, async () => {
      if (this.closing) throw new ThreadError('SERVER_STOPPING', 503);
      const runtime = await this.runtime(userId, id);
      if (runtime.data.acceptedIds.includes(input.id))
        return this.summary(runtime.thread, runtime);
      input = { ...input, ...(await this.runner.resolveSettings?.(input)) };
      if (runtime.data.toolInteractions.some((item) => !item.response))
        throw new ThreadError('TOOL_RESPONSE_REQUIRED', 409);
      await this.runner.validate(
        userId,
        input,
        threadScope(runtime.thread.resourceId).projectId,
      );
      const session = await this.session(runtime, input);
      const previous = structuredClone(runtime.data);
      if (!this.busy(runtime)) runtime.data.status = 'pending';
      runtime.data.error = null;
      try {
        await session.send(input);
      } catch (error) {
        runtime.data = previous;
        throw error;
      }
      runtime.data.acceptedIds = [...runtime.data.acceptedIds, input.id].slice(
        -200,
      );
      runtime.data.reasoningEffort = input.reasoningEffort;
      runtime.thread.metadata = {
        ...runtime.thread.metadata,
        model: input.model,
        agentId: input.agentId ?? null,
      };
      const generateTitle = runtime.data.autoTitle;
      if (generateTitle) {
        runtime.thread.title = messageText(input)
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        runtime.data.autoTitle = false;
      }
      await this.save(runtime);
      this.publish(runtime);
      if (generateTitle) void this.generateTitle(runtime, session, input);
      return this.summary(runtime.thread, runtime);
    });
  }

  private async generateTitle(
    runtime: Runtime,
    session: ChatSession,
    input: RunInput,
  ) {
    const generation = Symbol();
    runtime.titleGeneration = generation;
    try {
      // Do not hold the thread lock while waiting for the title model.
      const title = (await session.generateTitle(input))
        ?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      if (!title) return;
      await this.locked(runtime.thread.id, async () => {
        if (
          this.closing ||
          this.runtimes.get(runtime.thread.id) !== runtime ||
          runtime.titleGeneration !== generation
        )
          return;
        const previous = runtime.thread.title;
        runtime.thread.title = title;
        try {
          await this.save(runtime);
        } catch (error) {
          runtime.thread.title = previous;
          throw error;
        }
        this.publish(runtime);
      });
    } catch (error) {
      // A failed title must never change the chat's status or interrupt its stream.
      console.error('Thread title generation failed', error);
    } finally {
      if (runtime.titleGeneration === generation)
        runtime.titleGeneration = undefined;
    }
  }

  compact(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () => {
      if (this.closing) throw new ThreadError('SERVER_STOPPING', 503);
      const runtime = await this.runtime(userId, id);
      if (
        this.busy(runtime) ||
        runtime.data.status === 'suspended' ||
        runtime.data.toolInteractions.some((item) => !item.response) ||
        runtime.backgroundTasks.some(isBackgroundTaskActive) ||
        (runtime.goal?.status === 'active' && !runtime.goal.waitingForUser) ||
        (Array.isArray(runtime.thread.metadata?.queue) &&
          runtime.thread.metadata.queue.length)
      )
        throw new ThreadError('COMPACTION_BUSY', 409);
      clearTimeout(runtime.expiry);
      try {
        const session = await this.session(
          runtime,
          {
            agentId:
              typeof runtime.thread.metadata?.agentId === 'string'
                ? runtime.thread.metadata.agentId
                : null,
            model:
              typeof runtime.thread.metadata?.model === 'string'
                ? runtime.thread.metadata.model
                : null,
            reasoningEffort: runtime.data.reasoningEffort,
          },
          false,
        );
        return await session.compact();
      } finally {
        this.release(runtime);
      }
    });
  }

  clearGoal(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      const goal = await this.runner.getGoal?.(id);
      if (runtime.session) await runtime.session.clearGoal();
      else await this.runner.clearGoal?.(id);
      runtime.goal = null;
      if (goal?.status === 'active' && this.busy(runtime)) {
        runtime.data.status = 'canceled';
        runtime.data.activeId = null;
        runtime.activeMessageId = null;
      }
      await this.save(runtime);
      this.publish(runtime);
    });
  }

  respondToTool(
    userId: string,
    id: string,
    interactionId: string,
    raw: ToolResponse,
  ) {
    return this.scopeLocked(userId, id, async () => {
      if (this.closing) throw new ThreadError('SERVER_STOPPING', 503);
      const response = toolResponseSchema.parse(raw);
      const runtime = await this.runtime(userId, id);
      if (runtime.data.acceptedIds.includes(response.id))
        return this.summary(runtime.thread, runtime);
      const interaction = runtime.data.toolInteractions.find(
        (item) => item.id === interactionId && !item.response,
      );
      if (!interaction) throw new ThreadError('TOOL_NOT_PENDING', 409);
      if (
        runtime.data.status === 'running' ||
        runtime.data.status === 'pending'
      )
        throw new ThreadError('THREAD_BUSY', 409);
      validateToolResponse(interaction, response);
      const session = await this.session(runtime, interaction.settings, false);
      await session.respond(interaction, response, interaction.settings);
      interaction.response = response;
      runtime.data.acceptedIds = [
        ...runtime.data.acceptedIds,
        response.id,
      ].slice(-200);
      runtime.data.status = 'pending';
      runtime.data.error = null;
      await this.save(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  private upsert(runtime: Runtime, message: UIMessage) {
    const previous = new Map(runtime.messages.map((item) => [item.id, item]));
    runtime.messages = mergeThreadMessages(runtime.messages, [
      structuredClone(message),
    ]);
    const ids = new Set(runtime.messages.map((item) => item.id));
    for (const id of previous.keys()) {
      if (ids.has(id)) continue;
      runtime.changedMessages.delete(id);
      runtime.removedMessageIds.add(id);
    }
    for (const item of runtime.messages) {
      runtime.removedMessageIds.delete(item.id);
      if (previous.get(item.id) !== item)
        runtime.changedMessages.set(item.id, structuredClone(item));
      if (
        runtime.activeMessageId &&
        threadMessageSourceIds(item).includes(runtime.activeMessageId)
      )
        runtime.activeMessageId = item.id;
    }
  }

  abort(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      runtime.session?.abort();
      runtime.data.status = 'canceled';
      runtime.data.activeId = null;
      runtime.activeMessageId = null;
      await this.save(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  cancelBackgroundTask(userId: string, id: string, taskId: string) {
    return this.scopeLocked(userId, id, async () => {
      const thread = await this.accessible(userId, id);
      const manager = this.backgroundTaskManager;
      if (!manager) throw new ThreadError('BACKGROUND_TASKS_UNAVAILABLE', 503);
      const task = await manager.getTask(taskId);
      if (
        !task ||
        task.threadId !== id ||
        task.resourceId !== thread.resourceId
      )
        throw new ThreadError('BACKGROUND_TASK_NOT_FOUND', 404);
      // Mastra cancellation aborts the tool and is idempotent for terminal tasks.
      await manager.cancel(taskId);
      const runtime = this.runtimes.get(id);
      if (runtime?.backgroundObserver) {
        try {
          await runtime.backgroundObserver.refresh(taskId);
        } catch (error) {
          this.backgroundFailed(runtime, error);
        }
      }
    });
  }

  retry(userId: string, id: string) {
    return this.continueFromHistory(userId, id, 'retry');
  }

  continueRun(userId: string, id: string) {
    return this.continueFromHistory(userId, id, 'continue');
  }

  private continueFromHistory(
    userId: string,
    id: string,
    action: 'retry' | 'continue',
  ) {
    return this.scopeLocked(userId, id, async () => {
      if (this.closing) throw new ThreadError('SERVER_STOPPING', 503);
      const runtime = await this.runtime(userId, id);
      if (this.busy(runtime) || (action === 'retry' && !runtime.data.error))
        return this.summary(runtime.thread, runtime);
      if (
        action === 'continue' &&
        !canContinueThread(
          runtime.messages,
          runtime.data,
          runtime.data.toolInteractions,
        )
      )
        throw new ThreadError('CONTINUE_UNAVAILABLE', 409);
      if (
        action === 'retry' &&
        (runtime.data.toolInteractions.some((item) => !item.response) ||
          !runtime.messages.some((message) => message.role === 'user'))
      )
        throw new ThreadError('RETRY_UNAVAILABLE', 409);
      const settings: ChatSettings = {
        agentId:
          typeof runtime.thread.metadata?.agentId === 'string'
            ? runtime.thread.metadata.agentId
            : null,
        model:
          typeof runtime.thread.metadata?.model === 'string'
            ? runtime.thread.metadata.model
            : null,
        reasoningEffort: runtime.data.reasoningEffort,
      };
      const session = await this.session(runtime, settings);
      // The native retry starts a stream with no new input, preserving tool results.
      await session.retry(settings);
      runtime.data.error = null;
      runtime.data.status = 'pending';
      await this.save(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  getQueued(userId: string, id: string, messageId: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      if (!runtime.session)
        throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
      return runtime.session.getQueued(messageId);
    });
  }

  updateQueued(
    userId: string,
    id: string,
    messageId: string,
    patch: UpdateQueuedMessage,
  ) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      if (!runtime.session)
        throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
      await runtime.session.updateQueued(messageId, patch);
    });
  }

  moveQueued(
    userId: string,
    id: string,
    messageId: string,
    beforeId: string | null,
  ) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      if (!runtime.session)
        throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
      await runtime.session.moveQueued(messageId, beforeId);
    });
  }

  cancelQueued(userId: string, id: string, messageId: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      if (!runtime.session)
        throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
      runtime.session.cancelQueued(messageId);
    });
  }

  clearQueue(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      runtime.session?.clearQueue();
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  subscribe(
    userId: string,
    id: string,
    listener: (snapshot: ThreadSnapshot<UIMessage>, initial: boolean) => void,
    revoked?: (code?: string) => void,
  ) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      clearTimeout(runtime.expiry);
      const subscription: Subscription = {
        userId,
        listener,
        revoked,
        active: true,
        pending: Promise.resolve(),
      };
      runtime.listeners.add(subscription);
      await this.deliver(runtime, subscription, this.snapshot(runtime), true);
      return () => {
        subscription.active = false;
        runtime.listeners.delete(subscription);
        this.release(runtime);
      };
    });
  }

  deleteThread(userId: string, id: string) {
    return this.scopeLocked(
      userId,
      id,
      async () => {
        const thread = await this.accessible(userId, id, true);
        await this.manageable(userId, thread);
        // Repeating an old DELETE request must never permanently delete an archive.
        if (isArchived(thread)) return;
        const runtime = await this.runtime(userId, id);
        await this.assertNoBackgroundTasks(thread);
        if (
          this.busy(runtime) ||
          runtime.backgroundTasks.some(isBackgroundTaskActive) ||
          runtime.queueCount
        )
          throw new ThreadError('THREAD_BUSY', 409);
        if (runtime) {
          clearTimeout(runtime.expiry);
          clearTimeout(runtime.broadcast);
        }
        await runtime.backgroundObserver?.stop();
        await runtime.session?.close();
        runtime.session = undefined;
        const { projectId } = threadScope(thread.resourceId);
        if (projectId) await this.memory.deleteThread(id);
        else
          runtime.thread = await this.memory.updateThread({
            id,
            title: thread.title,
            metadata: { archivedAt: new Date().toISOString() },
          });
        this.navigation.publish(thread.resourceId!, {
          type: 'remove',
          id,
          projectId: projectId ?? null,
          ...(!projectId
            ? { archivedThread: this.summary(runtime.thread) }
            : {}),
        });
        for (const subscription of runtime.listeners) {
          subscription.active = false;
          subscription.revoked?.('THREAD_NOT_FOUND');
        }
        runtime.listeners.clear();
        this.runtimes.delete(id);
      },
      true,
    );
  }

  private async assertNoBackgroundTasks(thread: StorageThreadType) {
    const activeTasks = await this.backgroundTaskManager?.listTasks({
      threadId: thread.id,
      resourceId: thread.resourceId!,
      status: ['pending', 'running', 'suspended'],
      perPage: 1,
    });
    if (activeTasks?.tasks.length) throw new ThreadError('THREAD_BUSY', 409);
  }

  invalidateProject(projectId: string, userId?: string) {
    this.refreshNavigation(userId);
    for (const runtime of this.runtimes.values()) {
      if (runtime.thread.resourceId !== `project:${projectId}`) continue;
      for (const subscription of runtime.listeners) {
        if (userId && subscription.userId !== userId) continue;
        subscription.active = false;
        subscription.revoked?.();
        runtime.listeners.delete(subscription);
      }
      if (!userId) {
        clearTimeout(runtime.expiry);
        clearTimeout(runtime.broadcast);
        void runtime.backgroundObserver?.stop();
        void runtime.session?.close();
        this.runtimes.delete(runtime.thread.id);
        continue;
      }
      this.release(runtime);
    }
  }

  withProjectDeletion<T>(projectId: string, remove: () => Promise<T>) {
    return this.locked(`project:${projectId}`, async () => {
      const activeTasks = await this.backgroundTaskManager?.listTasks({
        resourceId: `project:${projectId}`,
        status: ['pending', 'running', 'suspended'],
        perPage: 1,
      });
      if (activeTasks?.tasks.length) throw new ThreadError('PROJECT_BUSY', 409);
      let page = 0;
      while (true) {
        const result = await this.memory.listThreads({
          filter: { resourceId: `project:${projectId}` },
          page,
          perPage: 100,
        });
        if (
          result.threads.some(
            (thread) =>
              !!this.runtimes.get(thread.id) &&
              this.busy(this.runtimes.get(thread.id)!),
          )
        )
          throw new ThreadError('PROJECT_BUSY', 409);
        if (!result.hasMore) break;
        page++;
      }
      const result = await remove();
      this.invalidateProject(projectId);
      return result;
    });
  }

  async shutdown() {
    this.closing = true;
    this.navigation.close();
    for (const runtime of this.runtimes.values()) {
      clearTimeout(runtime.expiry);
      clearTimeout(runtime.broadcast);
    }
    await Promise.allSettled(
      [...this.runtimes.values()].flatMap((runtime) => [
        runtime.session?.close(),
        runtime.backgroundObserver?.stop(),
      ]),
    );
    await Promise.allSettled([...this.locks.values()]);
    this.runtimes.clear();
  }
}
