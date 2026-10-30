import { setTimeout as delay } from 'node:timers/promises';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { activeRun, type BacktestRun } from '../../strategy-types.js';
import { StrategyError } from '../../server/strategies/schema.js';
import type { QuantDependencies } from './context.js';

/** Keep the native task alive for the persisted run, rather than only its enqueue. */
export function adoptBacktest(
  execution: ToolExecutionContext | undefined,
  records: QuantDependencies['records'],
  userId: string,
  initial: BacktestRun,
  view: (run: BacktestRun) => BacktestRun,
) {
  if (!execution?.background) return;
  const controller = new AbortController();
  const { signal } = controller;
  const completion = (async () => {
    let run = initial;
    let progress = '';
    try {
      while (true) {
        signal.throwIfAborted();
        const nextProgress = `${run.status}:${run.message}`;
        if (nextProgress !== progress) {
          progress = nextProgress;
          // Progress is optional; a disconnected stream must not stop the job.
          await execution.writer
            ?.write({
              run_id: run.id,
              status: run.status,
              message: run.message,
            })
            .catch(() => {});
        }
        signal.throwIfAborted();
        if (!activeRun(run.status)) break;
        await delay(1000, undefined, { signal });
        try {
          run = await records.run(userId, initial.id);
        } catch (error) {
          // Do not expose connection details in native task failures.
          throw new Error(
            error instanceof StrategyError
              ? error.code
              : '量化服务暂不可用，请使用回测 ID 查询任务状态。',
          );
        }
      }
      if (run.status === 'failed')
        throw new Error(
          `回测任务 ${run.id} 失败：${run.message || '请查看回测日志'}`,
        );
      return {
        run_id: run.id,
        run: view(run),
        terminal: true,
        message:
          run.status === 'cancelled'
            ? '回测任务已取消'
            : '回测任务已完成，请用 backtest_result 读取指标、交易数和日志。',
      };
    } catch (error) {
      // Preserve the native cancellation/timeout reason: resolving here would
      // incorrectly turn a timed-out background task into a successful one.
      if (signal.aborted) throw signal.reason;
      throw error;
    }
  })();
  execution.background.adopt({
    completion,
    cancel: async (reason) => {
      controller.abort(reason);
      await records.cancel(userId, initial.id);
    },
  });
}
