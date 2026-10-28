import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PluginTool, type PluginContext } from '@app/plugin-sdk/server';
import {
  compareBacktests,
  prepareBacktestComparison,
  validateComparisonRuns,
} from '../../server/strategies/comparison.js';
import type { BacktestRun } from '../../strategy-types.js';
import { quantToolContext, type QuantDependencies } from './context.js';

export class BacktestCompareTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const execute = quantToolContext(context, get);
    super(
      createTool({
        id: 'plugin_vibe_quant_backtest_compare',
        title: '对比策略版本回测效果',
        description:
          '对比同一策略不同版本已完成的普通回测。先用 backtest_list 查找各版本的 run_id，每个版本选择一条；run_ids 第一条为差值基准。返回总收益、年化、回撤、夏普、胜率、PF 等指标及逐年/逐月收益、差值和中文描述 description。优先选择相同标的、区间、周期和成本设置；设置或实际数据覆盖不同会提示且不排名，缺失期间不补零。点数与资金回测不能混比；调优最佳训练试验需单独用 backtest_start 运行后再比较。只读已有结果，不会启动回测。',
        inputSchema: z.object({
          run_ids: z
            .array(z.string())
            .describe(
              '同一策略至少两个不同版本的回测 ID，按对比顺序传入，第一条为基准。',
            ),
        }),
        execute: (input, execution) =>
          execute(execution, async ({ records }, actor, signal) => {
            const ids = [...new Set(input.run_ids)];
            const runs: BacktestRun[] = [];
            for (const id of ids) {
              signal?.throwIfAborted();
              runs.push(await records.run(actor.userId, id));
            }
            signal?.throwIfAborted();
            validateComparisonRuns(runs);
            const unavailable = runs.filter(
              (run) => run.status !== 'completed' || run.config.optimization,
            );
            if (unavailable.length)
              return {
                error: 'BACKTEST_COMPARISON_NOT_READY',
                message:
                  '请选择已完成的普通回测；调优任务需以固定版本和选定参数单独回测后再比较。',
                runs: unavailable.map((run) => ({
                  run_id: run.id,
                  status: run.status,
                  optimization: !!run.config.optimization,
                })),
              };
            const entries: ReturnType<typeof prepareBacktestComparison>[] = [];
            for (const run of runs) {
              signal?.throwIfAborted();
              const artifact = await records.artifact(run.id, 'result');
              signal?.throwIfAborted();
              if (!artifact)
                return {
                  error: 'BACKTEST_COMPARISON_RESULT_MISSING',
                  run_id: run.id,
                  message: '回测结果产物缺失，无法进行完整对比。',
                };
              try {
                entries.push(
                  prepareBacktestComparison(run, artifact.text, artifact.hash),
                );
              } catch {
                return {
                  error: 'BACKTEST_COMPARISON_RESULT_INVALID',
                  run_id: run.id,
                  message: '回测结果无效或未成功，无法进行完整对比。',
                };
              }
            }
            signal?.throwIfAborted();
            return compareBacktests(entries);
          }),
      }),
    );
  }
}
