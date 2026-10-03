import { nanoid } from 'nanoid';
import { convertMessages } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import type { StorageThreadType } from '@mastra/core/memory';
import type { UIMessage } from 'ai';
import type {
  ChatSettings,
  ChatSkill,
  MessagePage,
  RunInput,
  ThreadSnapshot,
  ThreadSummary,
  ThreadNavigationEvent,
  UpdateQueuedMessage,
  QueuedMessageDetail,
  ChatUsage,
  ToolInteraction,
  ToolResponse,
  ThreadStatus,
  ThreadStreamStatus,
  ThreadBackgroundTask,
} from '@aime/shared/threads';
import {
  runInputSchema,
  updateQueuedMessageSchema,
  toolResponseSchema,
  threadStreamStatusSchema,
} from '@aime/shared/threads';
import type { ProjectSummary } from '@aime/shared/projects';
import { ThreadError, threadErrorMessage } from './errors.js';
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
  revoked?: () => void;
  pending: Promise<void>;
};

type RunnerInput = RunInput & {
  resume?: {
    interactionId: string;
    runId: string;
    toolCallId: string;
    response: ToolResponse;
  };
};
type Pending = RunnerInput & { createdAt: string };
type ThreadData = {
  status: ThreadStatus;
  queue: Pending[];
  activeId: string | null;
  acceptedIds: string[];
  reasoningEffort: ChatSettings['reasoningEffort'];
  error: string | null;
  failedInput: RunnerInput | null;
  paused: boolean;
  autoTitle: boolean;
  usage: ChatUsage | null;
  toolInteractions: (ToolInteraction & { settings: ChatSettings })[];
};
type Runtime = {
  thread: StorageThreadType;
  data: ThreadData;
  messages: UIMessage[];
  changedMessages: Map<string, UIMessage>;
  stopping: boolean;
  activeMessageId: string | null;
  controller?: AbortController;
  job?: Promise<void>;
  listeners: Set<Subscription>;
  expiry?: ReturnType<typeof setTimeout>;
  broadcast?: ReturnType<typeof setTimeout>;
  navigationSignature?: string;
  backgroundTasks: ThreadBackgroundTask[];
  backgroundObserver?: ThreadBackgroundTasks;
  backgroundTasksError: 'BACKGROUND_TASKS_UNAVAILABLE' | null;
};

export interface ChatRunner {
  listSkills?(userId: string, projectId?: string): Promise<ChatSkill[]>;
  validate(
    userId: string,
    input: RunInput | ChatSettings,
    projectId?: string,
  ): Promise<void>;
  createWorkspace(userId: string, projectId?: string): Promise<string>;
  execute(context: {
    thread: StorageThreadType;
    input: RunnerInput;
    signal: AbortSignal;
    onMessage: (message: UIMessage) => void;
    onUsage: (usage: ChatUsage) => Promise<void>;
    onStatus: (status: ThreadStreamStatus) => void;
    takeImmediate: () => Promise<RunInput[]>;
    onBackgroundTaskStarted?: (taskId: string) => Promise<void>;
  }): Promise<{
    status: ThreadStreamStatus;
    toolInteractions: ToolInteraction[];
  } | void>;
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
const initialData = (): ThreadData => ({
  status: 'idle',
  queue: [],
  activeId: null,
  acceptedIds: [],
  reasoningEffort: 'auto',
  error: null,
  failedInput: null,
  paused: false,
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

  private async navigationSnapshot(
    userId: string,
  ): Promise<ThreadNavigationEvent> {
    const projects: ProjectSummary[] = [];
    if (this.projects?.list) {
      for (let page = 0; ; page++) {
        const result = await this.projects.list(userId, page, 100);
        projects.push(...result.projects);
        if (!result.hasMore) break;
      }
    }
    const threads = new Map<string, ThreadSummary>();
    for (const projectId of [
      undefined,
      ...projects.map((project) => project.id),
    ]) {
      const result = await this.memory.listThreads({
        filter: {
          resourceId: projectId ? `project:${projectId}` : `user:${userId}`,
        },
        page: 0,
        perPage: false,
        orderBy: { field: 'updatedAt', direction: 'DESC' },
      });
      for (const thread of result.threads)
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

  private async accessible(userId: string, id: string) {
    const thread = await this.memory.getThreadById({ threadId: id });
    if (!thread) throw new ThreadError('THREAD_NOT_FOUND', 404);
    const scope = threadScope(thread.resourceId);
    if (scope.type === 'project') {
      await this.projectAccess(userId, scope.projectId);
    } else if (scope.userId !== userId)
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
  ) {
    const thread = await this.accessible(userId, id);
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
      model:
        typeof thread.metadata?.model === 'string'
          ? thread.metadata.model
          : null,
      reasoningEffort: data.reasoningEffort,
      createdAt: new Date(thread.createdAt).toISOString(),
      updatedAt: new Date(thread.updatedAt).toISOString(),
      status: data.activeId && !runtime ? 'failed' : data.status,
      ...(runtime?.stopping ? { stopping: true } : {}),
      error: data.activeId && !runtime ? 'RUN_INTERRUPTED' : data.error,
      queue: data.queue
        .filter((input) => !input.resume)
        .map((input) => ({
          id: input.id,
          text: messageText(input).slice(0, 200),
          isImmediate: input.isImmediate,
          createdAt: input.createdAt,
        })),
    };
  }

  private snapshot(runtime: Runtime): ThreadSnapshot<UIMessage> {
    return {
      thread: this.summary(runtime.thread, runtime),
      messages: runtime.messages,
      activeMessageId: runtime.activeMessageId,
      usage: runtime.data.usage,
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
      };
      runtime.changedMessages.clear();
      const signature = JSON.stringify(snapshot.thread);
      if (signature !== runtime.navigationSignature) {
        runtime.navigationSignature = signature;
        if (snapshot.thread.error !== 'THREAD_NOT_FOUND')
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
      runtime.job ||
      runtime.listeners.size ||
      runtime.backgroundTasks.some(
        (task) => task.status === 'pending' || task.status === 'running',
      )
    )
      return;
    runtime.expiry = setTimeout(() => {
      if (!runtime.job && !runtime.listeners.size) {
        void runtime.backgroundObserver?.stop();
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

  private async runtime(userId: string, id: string) {
    const thread = await this.accessible(userId, id);
    const cached = this.runtimes.get(id);
    if (cached) return cached;
    const data = dataOf(thread);
    if (data.activeId) {
      data.activeId = null;
      data.error = 'RUN_INTERRUPTED';
      data.paused = true;
      data.status = 'failed';
    }
    const history = await this.history(userId, id);
    const runtime: Runtime = {
      thread,
      data,
      messages: history.messages,
      changedMessages: new Map(),
      stopping: false,
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
    const result = await this.memory.listThreads({
      filter: {
        resourceId: projectId ? `project:${projectId}` : `user:${userId}`,
      },
      page,
      perPage,
      orderBy: { field: 'updatedAt', direction: 'DESC' },
    });
    return {
      threads: result.threads.map((thread) =>
        this.summary(thread, this.runtimes.get(thread.id)),
      ),
      page,
      hasMore: result.hasMore,
    };
  }

  getThread(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () =>
      this.snapshot(await this.runtime(userId, id)),
    );
  }

  async workspaceDirectory(userId: string, id: string) {
    const thread = await this.accessible(userId, id);
    const path = thread.metadata?.workspace;
    if (typeof path !== 'string' || !path)
      throw new ThreadError('WORKSPACE_UNAVAILABLE', 404);
    return path;
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
      messages: convertMessages(ordered).to('AIV6.UI') as UIMessage[],
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
      if (input.model)
        await this.runner.validate(
          userId,
          {
            model: input.model,
            reasoningEffort:
              input.reasoningEffort ?? runtime.data.reasoningEffort,
          },
          threadScope(runtime.thread.resourceId).projectId,
        );
      if (input.title !== undefined) {
        runtime.thread.title = input.title;
        runtime.data.autoTitle = false;
      }
      if (input.model !== undefined)
        runtime.thread.metadata = {
          ...runtime.thread.metadata,
          model: input.model,
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
      if (runtime.stopping) throw new ThreadError('THREAD_STOPPING', 409);
      const direct =
        !runtime.job &&
        !runtime.data.toolInteractions.some((item) => !item.response);
      if (
        !direct &&
        (runtime.data.queue.length >= 20 ||
          JSON.stringify([...runtime.data.queue, input]).length >
            16 * 1024 * 1024)
      )
        throw new ThreadError('QUEUE_FULL', 429);
      await this.runner.validate(
        userId,
        input,
        threadScope(runtime.thread.resourceId).projectId,
      );
      const old = structuredClone(runtime.data);
      const oldThread = structuredClone(runtime.thread);
      const oldMessages = runtime.messages;
      const oldChangedMessages = new Map(runtime.changedMessages);
      const pending: Pending = {
        ...input,
        createdAt: new Date().toISOString(),
      };
      if (direct) runtime.data.activeId = input.id;
      else runtime.data.queue.push(pending);
      runtime.data.acceptedIds = [...runtime.data.acceptedIds, input.id].slice(
        -200,
      );
      runtime.data.error = null;
      runtime.data.failedInput = null;
      runtime.data.paused = false;
      runtime.data.reasoningEffort = input.reasoningEffort;
      runtime.thread.metadata = {
        ...runtime.thread.metadata,
        model: input.model,
      };
      if (runtime.data.autoTitle) {
        runtime.thread.title = messageText(input)
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        runtime.data.autoTitle = false;
      }
      try {
        if (direct) await this.accept(runtime, pending);
        await this.save(runtime);
      } catch (error) {
        runtime.data = old;
        runtime.thread = oldThread;
        runtime.messages = oldMessages;
        runtime.changedMessages = oldChangedMessages;
        throw error;
      }
      if (direct) this.start(runtime, pending);
      else this.publish(runtime);
      return this.summary(runtime.thread, runtime);
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
      if (runtime.job || runtime.data.queue.some((item) => item.resume))
        throw new ThreadError('THREAD_BUSY', 409);
      validateToolResponse(interaction, response);
      await this.runner.validate(
        userId,
        interaction.settings,
        threadScope(runtime.thread.resourceId).projectId,
      );
      const previous = structuredClone(runtime.data);
      runtime.data.queue.unshift({
        ...interaction.settings,
        id: response.id,
        parts: [],
        isImmediate: false,
        createdBy: userId,
        createdAt: new Date().toISOString(),
        resume: {
          interactionId,
          runId: interaction.runId,
          toolCallId: interaction.toolCallId,
          response,
        },
      });
      runtime.data.acceptedIds = [
        ...runtime.data.acceptedIds,
        response.id,
      ].slice(-200);
      runtime.data.paused = false;
      runtime.data.error = null;
      runtime.data.failedInput = null;
      try {
        await this.save(runtime);
      } catch (error) {
        runtime.data = previous;
        throw error;
      }
      this.start(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  private upsert(runtime: Runtime, message: UIMessage) {
    const index = runtime.messages.findIndex((item) => item.id === message.id);
    runtime.messages =
      index < 0
        ? [...runtime.messages, structuredClone(message)]
        : runtime.messages.map((item, i) =>
            i === index ? structuredClone(message) : item,
          );
    runtime.changedMessages.set(message.id, structuredClone(message));
  }

  private async accept(runtime: Runtime, input: RunInput) {
    const message: UIMessage = {
      id: input.id,
      role: 'user',
      parts: input.parts,
      metadata: {
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      },
    };
    const messages = convertMessages([message])
      .to('Mastra.V2')
      .map((item) => ({
        ...item,
        threadId: runtime.thread.id,
        resourceId: runtime.thread.resourceId,
        createdAt: new Date(),
      }));
    await this.memory.saveMessages({ messages });
    this.upsert(runtime, message);
  }

  private start(runtime: Runtime, direct?: RunnerInput) {
    if (
      runtime.job ||
      runtime.data.paused ||
      this.closing ||
      (runtime.data.toolInteractions.some((item) => !item.response) &&
        !(direct ?? runtime.data.queue[0])?.resume) ||
      (!direct && !runtime.data.queue.length)
    )
      return;
    runtime.data.status = 'pending';
    this.publish(runtime);
    clearTimeout(runtime.expiry);
    runtime.job = this.drain(runtime, direct)
      .catch(() => {
        runtime.data.status = 'failed';
        runtime.data.error = 'CHAT_FAILED';
        runtime.data.paused = true;
      })
      .finally(() => {
        runtime.job = undefined;
        runtime.controller = undefined;
        runtime.activeMessageId = null;
        runtime.stopping = false;
        this.publish(runtime);
        this.release(runtime);
        if (!runtime.data.paused) this.start(runtime);
      });
  }

  private async drain(runtime: Runtime, direct?: RunnerInput) {
    while (!runtime.data.paused && !this.closing) {
      const input = await this.locked(runtime.thread.id, async () => {
        if (
          runtime.data.paused ||
          (!direct && !runtime.data.queue.length) ||
          (runtime.data.toolInteractions.some((item) => !item.response) &&
            !(direct ?? runtime.data.queue[0])?.resume)
        )
          return null;
        const next = direct ?? runtime.data.queue[0];
        runtime.controller = new AbortController();
        if (!direct && !next.resume) await this.accept(runtime, next);
        if (direct) direct = undefined;
        else runtime.data.queue.shift();
        runtime.data.activeId = next.id;
        runtime.data.status = 'pending';
        await this.save(runtime);
        this.publish(runtime);
        return next;
      });
      if (!input) break;
      try {
        const result = await this.runner.execute({
          thread: runtime.thread,
          input,
          signal: runtime.controller!.signal,
          onBackgroundTaskStarted: async (taskId) => {
            try {
              await runtime.backgroundObserver?.refresh(taskId);
            } catch (error) {
              this.backgroundFailed(runtime, error);
            }
          },
          onStatus: (status) => {
            if (runtime.data.status === status) return;
            runtime.data.status = status;
            this.publish(runtime);
          },
          onMessage: (message) => {
            this.upsert(runtime, message);
            runtime.activeMessageId = message.id;
            this.publish(runtime, true);
          },
          onUsage: (usage) =>
            this.locked(runtime.thread.id, async () => {
              runtime.data.usage = structuredClone(usage);
              await this.save(runtime);
              this.publish(runtime);
            }),
          takeImmediate: () =>
            this.locked(runtime.thread.id, async () => {
              if (
                runtime.data.paused ||
                runtime.data.toolInteractions.some((item) => !item.response) ||
                runtime.controller?.signal.aborted
              )
                return [];
              const immediate = runtime.data.queue.filter(
                (item) => item.isImmediate,
              );
              for (const message of immediate)
                await this.accept(runtime, message);
              if (immediate.length) {
                runtime.data.queue = runtime.data.queue.filter(
                  (item) => !item.isImmediate,
                );
                await this.save(runtime);
                this.publish(runtime);
              }
              return immediate;
            }),
        });
        await this.locked(runtime.thread.id, async () => {
          runtime.data.failedInput = null;
          const interactions = runtime.data.toolInteractions.map(
            (interaction) =>
              interaction.id === input.resume?.interactionId
                ? { ...interaction, response: input.resume.response }
                : interaction,
          );
          for (const interaction of result?.toolInteractions ?? []) {
            // A tool can suspend again with the same call ID; keep only its newest request.
            const index = interactions.findIndex(
              (item) => item.toolCallId === interaction.toolCallId,
            );
            const pending = {
              ...interaction,
              settings: {
                model: input.model,
                reasoningEffort: input.reasoningEffort,
              },
            };
            if (index < 0) interactions.push(pending);
            else interactions[index] = pending;
          }
          const completed = interactions
            .filter((item) => item.response)
            .slice(-100);
          runtime.data.toolInteractions = [
            ...completed,
            ...interactions.filter((item) => !item.response),
          ];
          // Native runners return stream.status verbatim. Legacy runners without
          // a result keep the same lifecycle semantics.
          runtime.data.status =
            result?.status ??
            (runtime.controller?.signal.aborted
              ? 'canceled'
              : runtime.data.toolInteractions.some((item) => !item.response)
                ? 'suspended'
                : 'success');
          if (runtime.data.status !== 'success') runtime.data.paused = true;
        });
      } catch (error) {
        if (
          runtime.data.status === 'pending' ||
          runtime.data.status === 'running'
        )
          runtime.data.status = runtime.controller?.signal.aborted
            ? 'canceled'
            : 'failed';
        if (!runtime.controller?.signal.aborted) {
          runtime.data.error = threadErrorMessage(error);
          runtime.data.failedInput = structuredClone(input);
          runtime.data.paused = true;
        }
      }
      await this.locked(runtime.thread.id, async () => {
        runtime.data.activeId = null;
        runtime.activeMessageId = null;
        runtime.stopping = false;
        runtime.messages = runtime.messages.slice(-80);
        await this.save(runtime);
        this.publish(runtime);
      });
    }
  }

  abort(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      runtime.data.paused = true;
      if (runtime.job) runtime.stopping = true;
      runtime.controller?.abort();
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
    return this.scopeLocked(userId, id, async () => {
      if (this.closing) throw new ThreadError('SERVER_STOPPING', 503);
      const runtime = await this.runtime(userId, id);
      // Duplicate clicks must not enqueue another copy of the failed run.
      if (runtime.job || !runtime.data.error)
        return this.summary(runtime.thread, runtime);
      let input = runtime.data.failedInput;
      if (!input) {
        // Older threads and interrupted runs may only have their stored messages.
        const message = [...runtime.messages]
          .reverse()
          .find((item) => item.role === 'user');
        if (!message) throw new ThreadError('RETRY_UNAVAILABLE', 409);
        input = runInputSchema.parse({
          id: message.id,
          parts: message.parts,
          model: runtime.thread.metadata?.model ?? null,
          reasoningEffort: runtime.data.reasoningEffort,
          isImmediate: false,
        });
      }
      if (
        !input.resume &&
        runtime.data.toolInteractions.some((item) => !item.response)
      )
        throw new ThreadError('RETRY_UNAVAILABLE', 409);
      await this.runner.validate(
        userId,
        input,
        threadScope(runtime.thread.resourceId).projectId,
      );
      const previous = structuredClone(runtime.data);
      runtime.data.error = null;
      runtime.data.paused = false;
      runtime.data.activeId = input.id;
      try {
        await this.save(runtime);
      } catch (error) {
        runtime.data = previous;
        throw error;
      }
      // Reuse the accepted input ID; do not insert a second user message.
      this.start(runtime, input);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  resume(userId: string, id: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      runtime.data.paused = false;
      runtime.data.error = null;
      await this.save(runtime);
      this.start(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  cancelQueued(userId: string, id: string, messageId: string) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      runtime.data.queue = runtime.data.queue.filter(
        (item) => item.id !== messageId,
      );
      await this.save(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  getQueued(userId: string, id: string, messageId: string) {
    return this.scopeLocked(
      userId,
      id,
      async (): Promise<QueuedMessageDetail> => {
        const runtime = await this.runtime(userId, id);
        const message = runtime.data.queue.find(
          (item) => item.id === messageId,
        );
        if (!message) throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
        return {
          id: message.id,
          text: messageText(message),
          isImmediate: message.isImmediate,
          hasAttachments: message.parts.some((part) => part.type === 'file'),
        };
      },
    );
  }

  updateQueued(
    userId: string,
    id: string,
    messageId: string,
    input: UpdateQueuedMessage,
  ) {
    return this.changeQueue(userId, id, (queue) => {
      const patch = updateQueuedMessageSchema.parse(input);
      const index = queue.findIndex((item) => item.id === messageId);
      if (index < 0) throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
      const message = queue[index];
      // Edit the complete text while retaining attachments and the original author/model.
      const parts =
        patch.text === undefined
          ? message.parts
          : [
              ...message.parts.filter((part) => part.type !== 'text'),
              ...(patch.text
                ? [{ type: 'text' as const, text: patch.text }]
                : []),
            ];
      const updated = runInputSchema.parse({
        ...message,
        parts,
        isImmediate: patch.isImmediate ?? message.isImmediate,
      });
      queue[index] = { ...message, ...updated };
      return queue;
    });
  }

  moveQueued(
    userId: string,
    id: string,
    messageId: string,
    beforeId: string | null,
  ) {
    return this.changeQueue(userId, id, (queue) => {
      const index = queue.findIndex((item) => item.id === messageId);
      if (
        index < 0 ||
        (beforeId !== null && !queue.some((item) => item.id === beforeId))
      )
        throw new ThreadError('QUEUED_MESSAGE_NOT_FOUND', 409);
      if (messageId === beforeId) return queue;
      const [message] = queue.splice(index, 1);
      const target =
        beforeId === null
          ? queue.length
          : queue.findIndex((item) => item.id === beforeId);
      queue.splice(target, 0, message);
      return queue;
    });
  }

  private changeQueue(
    userId: string,
    id: string,
    change: (queue: Pending[]) => Pending[],
  ) {
    return this.scopeLocked(userId, id, async () => {
      const runtime = await this.runtime(userId, id);
      const previous = runtime.data.queue;
      const queue = change(structuredClone(previous));
      if (JSON.stringify(queue).length > 16 * 1024 * 1024)
        throw new ThreadError('QUEUE_FULL', 429);
      runtime.data.queue = queue;
      try {
        await this.save(runtime);
      } catch (error) {
        runtime.data.queue = previous;
        throw error;
      }
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  subscribe(
    userId: string,
    id: string,
    listener: (snapshot: ThreadSnapshot<UIMessage>, initial: boolean) => void,
    revoked?: () => void,
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
    return this.scopeLocked(userId, id, async () => {
      const thread = await this.accessible(userId, id);
      await this.manageable(userId, thread);
      const runtime = await this.runtime(userId, id);
      const activeTasks = await this.backgroundTaskManager?.listTasks({
        threadId: id,
        resourceId: thread.resourceId!,
        status: ['pending', 'running', 'suspended'],
        perPage: 1,
      });
      if (
        runtime?.job ||
        activeTasks?.tasks.length ||
        runtime.backgroundTasks.some(isBackgroundTaskActive) ||
        dataOf(await this.accessible(userId, id)).queue.length
      )
        throw new ThreadError('THREAD_BUSY', 409);
      if (runtime) {
        clearTimeout(runtime.expiry);
        clearTimeout(runtime.broadcast);
      }
      await this.memory.deleteThread(id);
      await runtime.backgroundObserver?.stop();
      this.navigation.publish(thread.resourceId!, {
        type: 'remove',
        id,
        projectId: threadScope(thread.resourceId).projectId ?? null,
      });
      if (runtime) {
        runtime.data.error = 'THREAD_NOT_FOUND';
        runtime.data.status = 'failed';
        this.publish(runtime);
        runtime.listeners.clear();
      }
      this.runtimes.delete(id);
    });
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
              this.runtimes.get(thread.id)?.job || dataOf(thread).queue.length,
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
      runtime.data.paused = true;
      runtime.controller?.abort();
      clearTimeout(runtime.expiry);
      clearTimeout(runtime.broadcast);
    }
    await Promise.allSettled(
      [...this.runtimes.values()].flatMap((runtime) => [
        runtime.job,
        runtime.backgroundObserver?.stop(),
      ]),
    );
  }
}
