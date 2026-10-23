import type { BacktestInput } from '../../strategy-types.js';
import type { QuantConfig } from '../config.js';
import type { StateStore } from '../state-store.js';
import type { StrategyStore } from './store.js';
import { StrategyError, backtestSchema } from './schema.js';

/** Shared by HTTP and Agent tools: submitting Python always requires an administrator. */
export async function enqueueBacktest(
  records: Pick<StrategyStore, 'enqueue' | 'cancel'>,
  market: {
    config: QuantConfig;
    state: Pick<StateStore, 'instrument'>;
    wake: () => void;
  },
  actor: { userId: string; isAdmin: boolean },
  strategyId: string,
  input: BacktestInput,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!actor.isAdmin)
    throw new StrategyError('SCRIPT_EXECUTION_ADMIN_REQUIRED', 403);
  const parsed = backtestSchema.safeParse(input);
  if (!parsed.success) throw new StrategyError('INVALID_BACKTEST_CONFIG', 400);
  const config = parsed.data;
  const item = await market.state.instrument(
    market.config.engine,
    config.symbol,
  );
  signal?.throwIfAborted();
  if (
    !item ||
    item.kind === 'option' ||
    (config.execution_model === 'continuous_price' &&
      item.kind !== 'continuous')
  )
    throw new StrategyError('UNSUPPORTED_INSTRUMENT', 400);
  if (item.kind === 'stock') {
    config.rules.multiplier = 1;
    config.rules.margin_rate = 1;
  }
  const run = await records.enqueue(
    actor.userId,
    strategyId,
    config,
    market.config.engine,
  );
  // A database insert may finish after the tool stopped waiting. Cancel that queued job too.
  if (signal?.aborted) {
    await records.cancel(actor.userId, run.id);
    signal.throwIfAborted();
  }
  market.wake();
  return run;
}
