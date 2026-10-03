import type {
  BackgroundTask,
  BackgroundTaskManager,
} from '@mastra/core/background-tasks';
import type { ThreadBackgroundTask } from '@aime/shared/threads';
import { setTimeout as delay } from 'node:timers/promises';

export type ThreadBackgroundTaskManager = Pick<
  BackgroundTaskManager,
  'stream' | 'listTasks' | 'getTask' | 'cancel'
>;
const HISTORY_LIMIT = 100;
const activeStatuses = ['pending', 'running', 'suspended'] as const;
export const isBackgroundTaskActive = (task: ThreadBackgroundTask) =>
  activeStatuses.some((status) => status === task.status);

function summarize(task: BackgroundTask): ThreadBackgroundTask {
  return {
    id: task.id,
    status: task.status,
    toolName: task.toolName,
    toolCallId: task.toolCallId,
    agentId: task.agentId,
    runId: task.runId,
    args: task.args,
    result: task.result,
    error: task.error ? { message: task.error.message } : undefined,
    createdAt: new Date(task.createdAt).toISOString(),
    startedAt: task.startedAt && new Date(task.startedAt).toISOString(),
    suspendedAt: task.suspendedAt && new Date(task.suspendedAt).toISOString(),
    completedAt: task.completedAt && new Date(task.completedAt).toISOString(),
    suspendPayload: task.suspendPayload,
  };
}

// One observer per thread runtime, independent of both a turn's abort signal
// and browser SSE connections. Mastra remains the authoritative task store.
export class ThreadBackgroundTasks {
  private controller = new AbortController();
  private tasks = new Map<string, ThreadBackgroundTask>();
  private pending: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;
  readonly done: Promise<void>;

  constructor(
    private manager: ThreadBackgroundTaskManager,
    private scope: { threadId: string; resourceId: string },
    private onChange: (tasks: ThreadBackgroundTask[]) => void,
    private onError: (error: unknown) => void,
  ) {
    // Subscribe before loading history; queued events reconcile any changes
    // during the initial read. includeExisting only replays running tasks.
    const subscription = this.subscribe();
    this.ready = this.enqueue(() => this.hydrate());
    this.done = this.consume(subscription)
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) this.onError(error);
      })
      .finally(() => {
        this.controller.abort();
      });
  }

  private subscribe() {
    const controller = new AbortController();
    const reader = this.manager
      .stream({
        ...this.scope,
        abortSignal: AbortSignal.any([
          this.controller.signal,
          controller.signal,
        ]),
      })
      .getReader();
    return { reader, controller };
  }

  private enqueue(action: () => Promise<void>) {
    const update = this.pending.then(action);
    this.pending = update.catch(() => {});
    return update;
  }

  private belongs(task: BackgroundTask) {
    return (
      task.threadId === this.scope.threadId &&
      task.resourceId === this.scope.resourceId
    );
  }

  private publish() {
    if (this.controller.signal.aborted) return;
    const sorted = [...this.tasks.values()].sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
    let completed = 0;
    for (const task of sorted) {
      if (!isBackgroundTaskActive(task) && ++completed > HISTORY_LIMIT)
        this.tasks.delete(task.id);
    }
    this.onChange(sorted.filter((task) => this.tasks.has(task.id)));
  }

  private async hydrate() {
    const tasks = new Map<string, ThreadBackgroundTask>();
    const recent = await this.manager.listTasks({
      ...this.scope,
      page: 0,
      perPage: HISTORY_LIMIT,
      orderDirection: 'desc',
    });
    for (const task of recent.tasks)
      if (this.belongs(task)) tasks.set(task.id, summarize(task));
    // Keep older active tasks even when there are more than 100 recent results.
    for (let page = 0; ; page++) {
      const result = await this.manager.listTasks({
        ...this.scope,
        status: [...activeStatuses],
        page,
        perPage: HISTORY_LIMIT,
        orderDirection: 'desc',
      });
      for (const task of result.tasks)
        if (this.belongs(task)) tasks.set(task.id, summarize(task));
      if (
        this.controller.signal.aborted ||
        !result.tasks.length ||
        (page + 1) * HISTORY_LIMIT >= result.total
      )
        break;
    }
    for (const task of tasks.values())
      task.lastOutput = this.tasks.get(task.id)?.lastOutput;
    this.tasks = tasks;
    this.publish();
  }

  async refresh(taskId: string, output?: { value: unknown }) {
    await this.ready;
    return this.enqueue(async () => {
      if (this.controller.signal.aborted) return;
      const previous = this.tasks.get(taskId);
      if (output && previous) {
        this.tasks.set(taskId, { ...previous, lastOutput: output.value });
        this.publish();
        return;
      }
      // Events omit fields, and task.failed also represents timed_out. Read the
      // authoritative row instead of guessing a status from the event name.
      const task = await this.manager.getTask(taskId);
      if (!task || !this.belongs(task) || this.controller.signal.aborted)
        return;
      this.tasks.set(taskId, {
        ...summarize(task),
        lastOutput: output ? output.value : previous?.lastOutput,
      });
      this.publish();
    });
  }

  private async consume(
    subscription: ReturnType<ThreadBackgroundTasks['subscribe']>,
  ) {
    try {
      await this.ready;
      let rehydrate = false;
      while (!this.controller.signal.aborted) {
        try {
          if (rehydrate) await this.enqueue(() => this.hydrate());
          while (!this.controller.signal.aborted) {
            const { done, value } = await subscription.reader.read();
            if (done) throw new Error('Background task stream closed');
            const payload = value.payload;
            if (
              !payload ||
              typeof payload !== 'object' ||
              !('taskId' in payload) ||
              typeof payload.taskId !== 'string'
            )
              continue;
            await this.refresh(
              payload.taskId,
              value.type === 'background-task-output' && 'payload' in payload
                ? { value: payload.payload }
                : undefined,
            );
          }
        } catch (error) {
          if (this.controller.signal.aborted) break;
          this.onError(error);
        }
        subscription.controller.abort();
        subscription.reader.releaseLock();
        // Recover missed events from storage when the manager stream reconnects.
        await delay(1000, undefined, { signal: this.controller.signal });
        subscription = this.subscribe();
        rehydrate = true;
      }
    } finally {
      subscription.controller.abort();
      subscription.reader.releaseLock();
    }
  }

  stop() {
    this.controller.abort();
    return Promise.allSettled([this.done, this.pending]);
  }
}
