import { nanoid } from 'nanoid';
import { convertMessages } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import type { StorageThreadType } from '@mastra/core/memory';
import type { UIMessage } from 'ai';
import type {
  ChatSettings,
  MessagePage,
  RunInput,
  ThreadSnapshot,
  ThreadSummary,
} from '@aime/shared/threads';
import { ThreadError } from './errors.js';

type Pending = RunInput & { createdAt: string };
type ThreadData = {
  queue: Pending[];
  activeId: string | null;
  acceptedIds: string[];
  reasoningEffort: ChatSettings['reasoningEffort'];
  error: string | null;
  paused: boolean;
  autoTitle: boolean;
};
type Runtime = {
  thread: StorageThreadType;
  data: ThreadData;
  messages: UIMessage[];
  changedMessages: Map<string, UIMessage>;
  status: ThreadSummary['status'];
  activeMessageId: string | null;
  controller?: AbortController;
  job?: Promise<void>;
  listeners: Set<
    (snapshot: ThreadSnapshot<UIMessage>, initial: boolean) => void
  >;
  expiry?: ReturnType<typeof setTimeout>;
  broadcast?: ReturnType<typeof setTimeout>;
};

export interface ChatRunner {
  validate(userId: string, input: RunInput | ChatSettings): Promise<void>;
  createWorkspace(userId: string): Promise<string>;
  execute(context: {
    thread: StorageThreadType;
    input: RunInput;
    signal: AbortSignal;
    onMessage: (message: UIMessage) => void;
    takeImmediate: () => Promise<RunInput[]>;
  }): Promise<void>;
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
  queue: [],
  activeId: null,
  acceptedIds: [],
  reasoningEffort: 'auto',
  error: null,
  paused: false,
  autoTitle: true,
});
function dataOf(thread: StorageThreadType): ThreadData {
  return {
    ...initialData(),
    ...(thread.metadata?.aime as Partial<ThreadData> | undefined),
  };
}
const messageText = (input: RunInput) =>
  input.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

// One process owns execution; subscribers only observe it. Closing a browser never aborts a run.
export class ThreadService {
  private runtimes = new Map<string, Runtime>();
  private locks = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(
    private memory: ThreadMemory,
    private runner: ChatRunner,
  ) {}

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

  private async owned(userId: string, id: string) {
    const thread = await this.memory.getThreadById({ threadId: id });
    if (!thread || thread.resourceId !== `user:${userId}`)
      throw new ThreadError('THREAD_NOT_FOUND', 404);
    return thread;
  }

  private summary(thread: StorageThreadType, runtime?: Runtime): ThreadSummary {
    const data = runtime?.data ?? dataOf(thread);
    return {
      id: thread.id,
      title: thread.title ?? '',
      model:
        typeof thread.metadata?.model === 'string'
          ? thread.metadata.model
          : null,
      reasoningEffort: data.reasoningEffort,
      createdAt: new Date(thread.createdAt).toISOString(),
      updatedAt: new Date(thread.updatedAt).toISOString(),
      status:
        runtime?.status ?? (data.activeId || data.error ? 'error' : 'idle'),
      error: data.activeId && !runtime ? 'RUN_INTERRUPTED' : data.error,
      queue: data.queue.map((input) => ({
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
      for (const listener of runtime.listeners) listener(snapshot, false);
    };
    if (throttle) {
      runtime.broadcast ??= setTimeout(send, 50);
    } else {
      clearTimeout(runtime.broadcast);
      send();
    }
  }

  private release(runtime: Runtime) {
    clearTimeout(runtime.expiry);
    if (runtime.job || runtime.listeners.size) return;
    runtime.expiry = setTimeout(() => {
      if (!runtime.job && !runtime.listeners.size)
        this.runtimes.delete(runtime.thread.id);
    }, 15 * 60_000);
    runtime.expiry.unref();
  }

  private async save(runtime: Runtime) {
    runtime.thread = await this.memory.updateThread({
      id: runtime.thread.id,
      title: runtime.thread.title,
      metadata: {
        model: runtime.thread.metadata?.model ?? null,
        aime: structuredClone(runtime.data),
      },
    });
  }

  private async runtime(userId: string, id: string) {
    const thread = await this.owned(userId, id);
    const cached = this.runtimes.get(id);
    if (cached) return cached;
    const data = dataOf(thread);
    if (data.activeId) {
      data.activeId = null;
      data.error = 'RUN_INTERRUPTED';
      data.paused = true;
    }
    const history = await this.history(userId, id);
    const runtime: Runtime = {
      thread,
      data,
      messages: history.messages,
      changedMessages: new Map(),
      status: data.error ? 'error' : 'idle',
      activeMessageId: null,
      listeners: new Set(),
    };
    this.runtimes.set(id, runtime);
    if (dataOf(thread).activeId) await this.save(runtime);
    this.release(runtime);
    return runtime;
  }

  async createThread(userId: string, input: ChatSettings & { title?: string }) {
    if (input.model) await this.runner.validate(userId, input);
    const workspace = await this.runner.createWorkspace(userId);
    const thread = await this.memory.createThread({
      threadId: nanoid(16),
      resourceId: `user:${userId}`,
      title: input.title ?? '',
      metadata: {
        model: input.model,
        createdBy: userId,
        workspace,
        aime: {
          ...initialData(),
          reasoningEffort: input.reasoningEffort,
          autoTitle: !input.title,
        },
      },
    });
    return this.summary(thread);
  }

  async listThreads(userId: string, page = 0) {
    const result = await this.memory.listThreads({
      filter: { resourceId: `user:${userId}` },
      page,
      perPage: 10,
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
    return this.locked(id, async () =>
      this.snapshot(await this.runtime(userId, id)),
    );
  }

  async history(
    userId: string,
    id: string,
    page = 0,
    anchor = new Date().toISOString(),
  ): Promise<MessagePage<UIMessage>> {
    await this.owned(userId, id);
    const result = await this.memory.recall({
      threadId: id,
      resourceId: `user:${userId}`,
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
    return this.locked(id, async () => {
      const runtime = await this.runtime(userId, id);
      if (input.model)
        await this.runner.validate(userId, {
          model: input.model,
          reasoningEffort:
            input.reasoningEffort ?? runtime.data.reasoningEffort,
        });
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
    return this.locked(id, async () => {
      if (this.closing) throw new ThreadError('SERVER_STOPPING', 503);
      const runtime = await this.runtime(userId, id);
      if (runtime.data.acceptedIds.includes(input.id))
        return this.summary(runtime.thread, runtime);
      if (runtime.status === 'stopping')
        throw new ThreadError('THREAD_STOPPING', 409);
      if (
        runtime.data.queue.length >= 20 ||
        JSON.stringify([...runtime.data.queue, input]).length > 16 * 1024 * 1024
      )
        throw new ThreadError('QUEUE_FULL', 429);
      await this.runner.validate(userId, input);
      const old = structuredClone(runtime.data);
      const oldThread = structuredClone(runtime.thread);
      runtime.data.queue.push({
        ...input,
        createdAt: new Date().toISOString(),
      });
      runtime.data.acceptedIds = [...runtime.data.acceptedIds, input.id].slice(
        -200,
      );
      runtime.data.error = null;
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
        await this.save(runtime);
      } catch (error) {
        runtime.data = old;
        runtime.thread = oldThread;
        throw error;
      }
      this.publish(runtime);
      this.start(runtime);
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

  private start(runtime: Runtime) {
    if (
      runtime.job ||
      runtime.data.paused ||
      this.closing ||
      !runtime.data.queue.length
    )
      return;
    runtime.status = 'running';
    clearTimeout(runtime.expiry);
    runtime.job = this.drain(runtime)
      .catch(() => {
        runtime.status = 'error';
        runtime.data.error = 'CHAT_FAILED';
        runtime.data.paused = true;
      })
      .finally(() => {
        runtime.job = undefined;
        runtime.controller = undefined;
        runtime.activeMessageId = null;
        runtime.status = runtime.data.error ? 'error' : 'idle';
        this.publish(runtime);
        this.release(runtime);
        if (!runtime.data.paused) this.start(runtime);
      });
  }

  private async drain(runtime: Runtime) {
    while (!runtime.data.paused && !this.closing) {
      const input = await this.locked(runtime.thread.id, async () => {
        if (runtime.data.paused || !runtime.data.queue.length) return null;
        const next = runtime.data.queue[0];
        runtime.controller = new AbortController();
        await this.accept(runtime, next);
        runtime.data.queue.shift();
        runtime.data.activeId = next.id;
        runtime.status = 'running';
        await this.save(runtime);
        this.publish(runtime);
        return next;
      });
      if (!input) break;
      try {
        await this.runner.execute({
          thread: runtime.thread,
          input,
          signal: runtime.controller!.signal,
          onMessage: (message) => {
            this.upsert(runtime, message);
            runtime.activeMessageId = message.id;
            this.publish(runtime, true);
          },
          takeImmediate: () =>
            this.locked(runtime.thread.id, async () => {
              if (runtime.data.paused || runtime.controller?.signal.aborted)
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
      } catch (error) {
        if (!runtime.controller?.signal.aborted) {
          runtime.data.error =
            error instanceof ThreadError ? error.code : 'CHAT_FAILED';
          runtime.data.paused = true;
        }
      }
      await this.locked(runtime.thread.id, async () => {
        runtime.data.activeId = null;
        runtime.activeMessageId = null;
        runtime.status = runtime.data.error ? 'error' : 'idle';
        runtime.messages = runtime.messages.slice(-80);
        await this.save(runtime);
        this.publish(runtime);
      });
    }
  }

  abort(userId: string, id: string) {
    return this.locked(id, async () => {
      const runtime = await this.runtime(userId, id);
      runtime.data.paused = true;
      if (runtime.job) runtime.status = 'stopping';
      runtime.controller?.abort();
      await this.save(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  resume(userId: string, id: string) {
    return this.locked(id, async () => {
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
    return this.locked(id, async () => {
      const runtime = await this.runtime(userId, id);
      runtime.data.queue = runtime.data.queue.filter(
        (item) => item.id !== messageId,
      );
      await this.save(runtime);
      this.publish(runtime);
      return this.summary(runtime.thread, runtime);
    });
  }

  subscribe(
    userId: string,
    id: string,
    listener: (snapshot: ThreadSnapshot<UIMessage>, initial: boolean) => void,
  ) {
    return this.locked(id, async () => {
      const runtime = await this.runtime(userId, id);
      clearTimeout(runtime.expiry);
      runtime.listeners.add(listener);
      listener(this.snapshot(runtime), true);
      return () => {
        runtime.listeners.delete(listener);
        this.release(runtime);
      };
    });
  }

  deleteThread(userId: string, id: string) {
    return this.locked(id, async () => {
      await this.owned(userId, id);
      const runtime = this.runtimes.get(id);
      if (runtime?.job || dataOf(await this.owned(userId, id)).queue.length)
        throw new ThreadError('THREAD_BUSY', 409);
      if (runtime) {
        clearTimeout(runtime.expiry);
        clearTimeout(runtime.broadcast);
      }
      await this.memory.deleteThread(id);
      if (runtime) {
        runtime.data.error = 'THREAD_NOT_FOUND';
        runtime.status = 'error';
        this.publish(runtime);
        runtime.listeners.clear();
      }
      this.runtimes.delete(id);
    });
  }

  async shutdown() {
    this.closing = true;
    for (const runtime of this.runtimes.values()) {
      runtime.data.paused = true;
      runtime.controller?.abort();
      clearTimeout(runtime.expiry);
      clearTimeout(runtime.broadcast);
    }
    await Promise.allSettled(
      [...this.runtimes.values()].map((runtime) => runtime.job),
    );
  }
}
