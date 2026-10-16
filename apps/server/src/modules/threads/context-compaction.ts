import type { ChatUsage } from '@aime/shared/threads';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import type { ThreadStateStorage } from '@mastra/core/storage';
import {
  ObservationalMemory,
  ObservationalMemoryProcessor,
  type ObservationalMemoryConfig,
  type ObservationalMemoryRecord,
  type MemoryContextProvider,
} from '@mastra/memory/processors';

const STATE_TYPE = 'context-compaction';
const CONTEXT_RATIO = 0.8;

/** The latest valid actor usage, consumed only after a successful observation. */
export class ContextBudget {
  private limit: number | undefined;

  private constructor(
    private readonly store: ThreadStateStorage | undefined,
    private readonly threadId: string,
    private totalTokens: number | null,
  ) {}

  static async load(
    store: ThreadStateStorage | undefined,
    threadId: string,
    previousUsage: unknown,
    recoverUsage?: () => Promise<{ totalTokens: number } | undefined>,
  ) {
    const saved = await store?.getState<{ totalTokens: number | null }>({
      threadId,
      type: STATE_TYPE,
    });
    let total = saved
      ? saved.totalTokens
      : (previousUsage as Partial<ChatUsage> | null)?.totalTokens;
    if (
      !saved &&
      (typeof total !== 'number' || !Number.isFinite(total) || total < 0)
    )
      total = (await recoverUsage?.())?.totalTokens;
    return new ContextBudget(
      store,
      threadId,
      typeof total === 'number' && Number.isFinite(total) && total >= 0
        ? total
        : null,
    );
  }

  setLimit(limit: number | undefined) {
    this.limit = limit;
  }

  get shouldCompact() {
    return (
      this.totalTokens !== null &&
      this.limit !== undefined &&
      Number.isFinite(this.limit) &&
      this.limit > 0 &&
      this.totalTokens >= this.limit * CONTEXT_RATIO
    );
  }

  async record(usage: ChatUsage) {
    const total = usage.totalTokens;
    // Failed/aborted steps can report no usage. Keep the last valid measurement.
    if (total === undefined || !Number.isFinite(total) || total < 0) return;
    await this.save(total);
  }

  async consume() {
    await this.save(null);
  }

  private async save(totalTokens: number | null) {
    await this.store?.setState({
      threadId: this.threadId,
      type: STATE_TYPE,
      value: { totalTokens },
    });
    this.totalTokens = totalTokens;
  }
}

/** Add a provider-usage trigger while retaining Mastra's native turn lifecycle. */
class ContextObservationalMemory extends ObservationalMemory {
  private forcingObservation = false;

  constructor(
    config: ObservationalMemoryConfig,
    private readonly budget: ContextBudget,
  ) {
    super(config);
  }

  override async getStatus(
    opts: Parameters<ObservationalMemory['getStatus']>[0],
  ) {
    const status = await super.getStatus(opts);
    if (this.budget.shouldCompact && status.pendingTokens > 0)
      return { ...status, shouldObserve: true, threshold: 1 };
    return status;
  }

  override async getOrCreateRecord(threadId: string, resourceId?: string) {
    const record = await super.getOrCreateRecord(threadId, resourceId);
    if (!this.forcingObservation) return record;
    // observe() rechecks the threshold inside its lock. Supply a transient view
    // for that call only: never write 1 to storage or mutate a cached turn record.
    const overrides = record.config?._overrides as
      { observation?: Record<string, unknown> } | undefined;
    return {
      ...record,
      config: {
        ...record.config,
        _overrides: {
          ...overrides,
          observation: { ...overrides?.observation, messageTokens: 1 },
        },
      },
    } satisfies ObservationalMemoryRecord;
  }

  override async observe(opts: Parameters<ObservationalMemory['observe']>[0]) {
    this.forcingObservation = this.budget.shouldCompact;
    try {
      const result = await super.observe(opts);
      // Also consume usage when the ordinary 30k condition fired first.
      if (result.observed) await this.budget.consume();
      return result;
    } finally {
      this.forcingObservation = false;
    }
  }
}

export class ContextCompactionProcessor extends ObservationalMemoryProcessor {
  constructor(
    config: ObservationalMemoryConfig,
    memory: MemoryContextProvider,
    private readonly budget: ContextBudget,
    private readonly resolveLimit: (
      args: ProcessInputStepArgs,
    ) => Promise<number | undefined>,
    private readonly onError: (error: unknown) => void,
  ) {
    super(new ContextObservationalMemory(config, budget), memory);
  }

  override async processInputStep(args: ProcessInputStepArgs) {
    // This hook runs for every model step, including uninterrupted tool loops.
    // Resolve queued model changes before testing their context capacity.
    try {
      this.budget.setLimit(await this.resolveLimit(args));
      return await super.processInputStep(args);
    } catch (error) {
      // Native memory aborts surface as processor tripwires, which are not always
      // forwarded as run errors by the thread subscription. Publish the failure
      // so the chat cannot remain stuck in "running" after a failed observation.
      if (!args.abortSignal?.aborted) this.onError(error);
      throw error;
    }
  }
}
