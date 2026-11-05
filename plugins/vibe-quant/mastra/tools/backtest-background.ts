import { setTimeout as delay } from 'node:timers/promises';
import { activeRun, type BacktestRun } from '../../strategy-types.js';
import { StrategyError } from '../../server/strategies/schema.js';
import type { QuantDependencies } from './context.js';

// Mastra 1.72 always starts a timer: 0 and Infinity expire immediately.
// Use Node's largest safe delay (~24.9 days), without changing the worker's execution budget.
export const BACKTEST_BACKGROUND_TIMEOUT_MS = 2_147_483_647;

export function waitForBacktest<T>(
  records: QuantDependencies['records'],
  userId: string,
  submitted: BacktestRun,
  result: (run: BacktestRun) => Promise<T>,
  progress?: (run: BacktestRun) => Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      // Cancellation must settle even while storage is unavailable or a read is pending.
      void records.cancel(userId, submitted.id).catch(() => {});
      reject(signal?.reason ?? new Error('用户中止了操作'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  const track = async () => {
    let run = submitted;
    let previous = '';
    while (true) {
      signal?.throwIfAborted();
      const state = `${run.status}:${run.message}:${run.cancel_requested}`;
      if (state !== previous) {
        previous = state;
        // Losing a progress subscriber must not lose the durable task's result.
        await progress?.(run).catch(() => {});
      }
      signal?.throwIfAborted();
      if (!activeRun(run.status)) {
        if (run.config.optimization && run.status === 'completed') {
          // The worker persists completion just before creating the version.
          // This idempotent operation also closes that small notification race.
          const { version } = await records.createOptimizationVersion(
            userId,
            run.id,
          );
          run = { ...run, optimization_version_id: version.id };
          signal?.throwIfAborted();
        }
        return result(run);
      }
      await delay(1000, undefined, { signal });
      run = await records.run(userId, run.id);
    }
  };
  return Promise.race([track(), aborted])
    .catch((error: unknown) => {
      if (signal?.aborted) throw signal.reason;
      // Storage errors can contain connection details; keep them out of task history.
      throw new Error(
        `回测任务 ${submitted.id} 结果读取失败：${error instanceof StrategyError ? error.code : '量化服务暂不可用，请用 backtest_status/result 重试。'}`,
      );
    })
    .finally(() => signal?.removeEventListener('abort', onAbort));
}
