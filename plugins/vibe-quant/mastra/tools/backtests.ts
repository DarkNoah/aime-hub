import { setTimeout as delay } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PluginTool, type PluginContext } from '@app/plugin-sdk/server';
import {
  activeRun,
  type BacktestResult,
  type BacktestRun,
} from '../../strategy-types.js';
import {
  backtestSchema,
  parseBacktestConfig,
  StrategyError,
} from '../../server/strategies/schema.js';
import { enqueueBacktest } from '../../server/strategies/enqueue.js';
import { OPTIMIZATION_METRICS } from '../../optimization-types.js';
import type { OptimizationReport } from '../../optimization-types.js';
import { quantToolContext, type QuantDependencies } from './context.js';
import { BacktestCompareTool } from './backtest-compare.js';
import { backtestSummary } from './backtest-summary.js';
import {
  BACKTEST_BACKGROUND_TIMEOUT_MS,
  waitForBacktest,
} from './backtest-background.js';

function runView(run: BacktestRun): BacktestRun {
  return {
    ...(run.optimization_draft_id
      ? { optimization_draft_id: run.optimization_draft_id }
      : {}),
    ...(run.optimization_version_id
      ? { optimization_version_id: run.optimization_version_id }
      : {}),
    id: run.id,
    strategy_id: run.strategy_id,
    version_id: run.version_id,
    version_number: run.version_number,
    version_name: run.version_name,
    source_hash: run.source_hash,
    engine: run.engine,
    status: run.status,
    message: run.message,
    config: run.config,
    cancel_requested: run.cancel_requested,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

async function completedBacktest(
  records: QuantDependencies['records'],
  run: BacktestRun,
) {
  const [artifact, optimizationArtifact] = await Promise.all([
    records.artifact(run.id, 'result'),
    run.config.optimization ? records.artifact(run.id, 'optimization') : null,
  ]);
  const report = optimizationArtifact
    ? (JSON.parse(optimizationArtifact.text) as OptimizationReport)
    : null;
  return {
    run_id: run.id,
    run: runView(run),
    terminal: true,
    message: run.message,
    result: artifact
      ? backtestSummary(
          JSON.parse(artifact.text) as BacktestResult,
          artifact.hash,
        )
      : null,
    optimization: report
      ? { ...report, trials: undefined, trial_count: report.trials.length }
      : null,
  };
}

export const agentBacktestSchema = z.object({
  backtest_engine: z
    .enum(['builtin', 'tqsdk'])
    .optional()
    .describe(
      '默认 builtin；tqsdk 使用 TqBacktest + TqSim，仅支持单个期货实际合约，不支持主连、点数和调优。',
    ),
  tq_options: z
    .object({
      commission_per_lot: z.number().optional(),
      margin_per_lot: z.number().optional(),
    })
    .optional()
    .describe(
      '天勤引擎的每手手续费、每手保证金（元）；省略使用 TqSim 默认。rules 与 participation_rate 仅用于内置引擎。',
    ),
  version_id: z
    .string()
    .describe('strategy_publish 或 strategy_versions 返回的版本 ID'),
  strategy_id: z.string().optional().describe('可省略，由版本自动确定所属策略'),
  symbol: z.string().describe('instrument_search 返回的标准标的代码'),
  start: z.number().describe('UTC epoch 秒。中文日期按 Asia/Shanghai 转换。'),
  end: z.number().describe('UTC epoch 秒，不晚于当前时间，区间不超过十年。'),
  duration: backtestSchema.shape.duration
    .default(60)
    .describe('K 线秒数：60、180、300、900、1800、3600、86400'),
  initial_cash: z.number().default(1_000_000),
  parameters: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('覆盖固定版本的同名参数；省略时使用版本参数'),
  rules: z
    .object({
      multiplier: z.number(),
      margin_rate: z.number(),
      lot_size: z.number(),
      t_plus_one: z.boolean(),
      fees: z.object({
        mode: z
          .enum(['fixed', 'rate', 'combined'])
          .optional()
          .describe(
            'fixed 按手/股固定金额；rate 按成交额；combined 两者叠加（省略时沿用）。最低费用和卖出税费在所有模式下生效。',
          ),
        per_unit: z.number(),
        rate: z.number(),
        minimum: z.number(),
        close_today_per_unit: z.number().nullable(),
        close_today_rate: z.number().nullable(),
        sell_tax_rate: z.number(),
      }),
    })
    .optional()
    .describe(
      '内置资金回测须提供用户给定或核实的交易规则，费率用小数；点数或天勤回测可省略',
    ),
  execution_model: z
    .enum(['actual_contract', 'continuous_price', 'points'])
    .optional()
    .describe(
      '默认 actual_contract 使用历史实际合约；continuous_price 用主连价格模拟；points 按固定 1 单位计算价格点差，支持指数，忽略资金、保证金、乘数、成交量和 T+1，结果单位为点。',
    ),
  point_cost: z
    .number()
    .default(0)
    .describe('点数回测每次开仓或平仓的成本（点），往返扣两次'),
  slippage_ticks: z.number().default(1),
  participation_rate: z.number().default(0.1),
  annualization: z.number().default(252),
  risk_free_rate: z.number().default(0),
  benchmark_symbol: z.string().nullable().default(null),
  calendar: z.record(z.string(), z.boolean()).optional(),
});

// Cross-field rules and resource limits are validated by parseBacktestConfig at execution.
const optimizationInput = z.object({
  search_space: z.record(
    z.string(),
    z.object({
      type: z.enum(['int', 'float', 'categorical']),
      low: z.number().optional(),
      high: z.number().optional(),
      step: z.number().optional(),
      log: z.boolean().optional(),
      choices: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional(),
    }),
  ),
  metric: z
    .enum(
      Object.keys(OPTIMIZATION_METRICS) as [
        keyof typeof OPTIMIZATION_METRICS,
        ...Array<keyof typeof OPTIMIZATION_METRICS>,
      ],
    )
    .default('sharpe'),
  n_trials: z.number().default(30),
  timeout_seconds: z
    .number()
    .default(0)
    .describe('调参搜索预算秒数，0 表示不限时'),
  seed: z.number().default(42),
  min_trades: z.number().default(1),
  validation_start: z.number().optional(),
});

export class BacktestStartTool extends PluginTool {
  constructor(
    context: PluginContext,
    get: () => QuantDependencies,
    optimize = false,
  ) {
    const execute = quantToolContext(context, get);
    const tool = createTool({
      id: optimize
        ? 'plugin_vibe_quant_backtest_optimize'
        : 'plugin_vibe_quant_backtest_start',
      title: optimize ? '执行参数调优' : '执行策略回测',
      background: {
        enabled: true,
        defaultDisposition: 'foreground',
        timeoutMs: BACKTEST_BACKGROUND_TIMEOUT_MS,
        maxRetries: 0,
      },
      description: optimize
        ? '管理员执行 Optuna 参数调优。默认前台阻塞等待；需要后台执行时由 Agent 直接调用并传 _background: { enabled: true }（或 disposition: deferred），交给 Mastra 原生后台任务，不放进 exec。调优成功后以新版本在原 start/end 完整区间内再执行一次普通回测，沿用行情、资金和交易设置，等待该回测结束后一起返回。backtest.run_id 是普通回测历史记录 ID，backtest.result.metrics 是此次完整区间回测指标；顶层 result.metrics 仍是最佳训练指标，optimization 保留最佳参数、优化目标值和留出验证指标。成功后以最佳参数在当前策略中创建新版本，命名为原版本名.opt.vN，例如 v6.opt.v1，末尾序号按该原版本递增。只搜索所选版本已有的默认参数，未搜索的参数沿用原默认值。提供 version_id、symbol、start、end、rules 和 optimization.search_space。默认 30 次、不限搜索时间、TPE 种子 42；可设置 timeout_seconds 搜索预算和 validation_start 留出验证。调优任务本身不列入普通回测历史，后续普通回测会保存到历史；无需 Agent 再调用 backtest_start。后台模式启动后可告知用户正在执行；不要持续轮询或重复提交。收到完成结果后向用户汇报策略指标，区分样本内与留出验证。可用 backtest_status/result/cancel 查询明细或取消回测 run_id，也可在聊天后台任务卡片取消。'
        : '管理员执行历史回测。默认前台阻塞等待；需要后台执行时由 Agent 直接调用并传 _background: { enabled: true }（或 disposition: deferred），交给 Mastra 原生后台任务，不放进 exec。完成后自动返回策略指标、交易数量和最近日志。默认内置引擎需要 version_id、symbol、start、end、rules。backtest_engine=tqsdk 使用天勤历史行情和 TqSim，仅支持单个期货实际合约；rules 可省略，tq_options 可覆盖每手手续费和保证金。默认资金 100 万、1 分钟 K 线、滑点 1 tick；内置引擎参与率 10%。后台模式启动后可告知用户正在执行；不要持续轮询或重复提交。收到完成结果后向用户汇报策略指标，检查交易数、指标单位和日志。可用 backtest_status/result/cancel 查询明细或取消回测 run_id，也可在聊天后台任务卡片取消。',
      inputSchema: optimize
        ? agentBacktestSchema.extend({ optimization: optimizationInput })
        : agentBacktestSchema,
      execute: async (input, execution) => {
        const result = await execute(execution, async (deps, actor, signal) => {
          if (!actor.isAdmin)
            throw new StrategyError('SCRIPT_EXECUTION_ADMIN_REQUIRED', 403);
          // The owned immutable version determines the strategy; never infer a latest version.
          const version = await deps.records.version(
            actor.userId,
            input.version_id,
          );
          if (input.strategy_id && version.strategy_id !== input.strategy_id)
            throw new StrategyError('VERSION_NOT_FOUND', 404);
          signal?.throwIfAborted();
          await deps.records.detail(actor.userId, version.strategy_id);
          signal?.throwIfAborted();
          const run = await enqueueBacktest(
            deps.records,
            deps,
            actor,
            version.strategy_id,
            parseBacktestConfig({
              ...input,
              parameters: { ...version.parameters, ...input.parameters },
            }),
            signal,
          );
          const progress = async (current: BacktestRun) => {
            await execution?.writer?.write({
              run_id: current.id,
              ...(optimize
                ? {
                    optimization_run_id: run.id,
                    phase: current.config.optimization
                      ? 'optimization'
                      : 'backtest',
                  }
                : {}),
              status: current.status,
              message: current.message,
              cancel_requested: current.cancel_requested,
            });
          };
          // Native dispatch owns the background lifecycle. Both modes wait for
          // optimization AND its subsequent ordinary backtest to finish.
          const result = await waitForBacktest(
            deps.records,
            actor.userId,
            run,
            (finished) => completedBacktest(deps.records, finished),
            progress,
            signal,
          );
          if (!optimize || result.run.status !== 'completed') return result;

          let backtest: BacktestRun | undefined;
          try {
            signal?.throwIfAborted();
            if (!result.run.optimization_version_id)
              throw new StrategyError('OPTIMIZATION_RESULT_MISSING', 409);
            const optimized = await deps.records.version(
              actor.userId,
              result.run.optimization_version_id,
            );
            // The new immutable version owns the winning defaults. Do not
            // reapply the original overrides or the training/validation split.
            const config = {
              ...result.run.config,
              version_id: optimized.id,
              parameters: optimized.parameters,
            };
            delete config.optimization;
            backtest = await enqueueBacktest(
              deps.records,
              {
                ...deps,
                config: { ...deps.config, engine: result.run.engine },
              },
              actor,
              result.run.strategy_id,
              config,
              signal,
            );
            return {
              ...result,
              backtest: await waitForBacktest(
                deps.records,
                actor.userId,
                backtest,
                (finished) => completedBacktest(deps.records, finished),
                progress,
                signal,
              ),
            };
          } catch (error) {
            signal?.throwIfAborted();
            // Preserve the successful optimization and any queued run ID when
            // the subsequent submission or result lookup fails.
            return {
              ...result,
              backtest: {
                ...(backtest ? { run_id: backtest.id } : {}),
                error:
                  error instanceof StrategyError
                    ? error.code
                    : 'QUANT_SERVICE_UNAVAILABLE',
                message: backtest
                  ? '调优已完成，后续回测结果暂不可用，请按 run_id 查询状态和结果。'
                  : '调优已完成，后续回测提交失败，可用 optimization_version_id 重试普通回测。',
              },
            };
          }
        });
        // The native manager must classify its abort as cancelled/timed_out,
        // rather than recording the foreground cancellation text as success.
        if (execution?.agent?.isBackgroundTask)
          execution.abortSignal?.throwIfAborted();
        return result;
      },
    });
    super(tool);
  }
}

export class BacktestListTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const execute = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_backtest_list',
      title: '查询回测历史',
      description:
        '读取指定共享策略最近 30 条回测；before 为上一页最后一条回测 ID。',
      inputSchema: z.object({
        strategy_id: z.string(),
        before: z.string().optional(),
      }),
      execute: (input, execution) =>
        execute(execution, async ({ records }, actor) => {
          const runs = await records.runs(
            actor.userId,
            input.strategy_id,
            input.before,
          );
          return {
            runs: runs.map(runView),
            next_before: runs.length === 30 ? runs.at(-1)!.id : null,
          };
        }),
    });
    super(tool);
  }
}

export class BacktestStatusTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const execute = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_backtest_status',
      title: '查询回测进度',
      description:
        '按需查询共享回测或调优任务状态，默认立即返回。wait=true 时最多等待 10 秒或直至结束；回测在独立队列中持续执行，不要为等待完成而在本轮持续轮询。中止此等待不会取消后台回测。',
      inputSchema: z.object({
        run_id: z.string(),
        wait: z.boolean().default(false),
      }),
      execute: (input, execution) =>
        execute(execution, async ({ records }, actor, signal) => {
          const deadline = Date.now() + (input.wait ? 10_000 : 0);
          let run = await records.run(actor.userId, input.run_id);
          while (activeRun(run.status) && Date.now() < deadline) {
            signal?.throwIfAborted();
            await delay(Math.min(1000, deadline - Date.now()), undefined, {
              signal,
            });
            run = await records.run(actor.userId, input.run_id);
          }
          return { run: runView(run), terminal: !activeRun(run.status) };
        }),
    });
    super(tool);
  }
}

export class BacktestResultTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const execute = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_backtest_result',
      title: '读取回测结果',
      description:
        '读取回测指标、记录数量和最近日志；section 可读取交易、委托、成交、信号、权益或风险线，每页 50 条，用 next_offset 继续。完成状态仍需检查交易数和日志。',
      inputSchema: z.object({
        run_id: z.string(),
        section: z
          .enum([
            'summary',
            'trades',
            'orders',
            'fills',
            'signals',
            'logs',
            'equity_curve',
            'risk_levels',
            'optimization_trials',
          ])
          .default('summary'),
        offset: z.number().default(0),
      }),
      execute: (input, execution) =>
        execute(execution, async ({ records }, actor, signal) => {
          input.offset = Math.max(0, Math.floor(input.offset));
          const run = await records.run(actor.userId, input.run_id);
          signal?.throwIfAborted();
          // Resolve the shared run before reading its artifacts; authentication is checked by tool context.
          const artifact = await records.artifact(run.id, 'result');
          const base = { run: runView(run), terminal: !activeRun(run.status) };
          const reportArtifact = run.config.optimization
            ? await records.artifact(run.id, 'optimization')
            : null;
          const report = reportArtifact
            ? (JSON.parse(reportArtifact.text) as OptimizationReport)
            : null;
          const optimization = report
            ? {
                ...report,
                trials: undefined,
                trial_count: report.trials.length,
              }
            : null;
          if (input.section === 'optimization_trials') {
            const rows = report?.trials ?? [];
            const next = input.offset + 50;
            return {
              ...base,
              optimization,
              data: rows.slice(input.offset, next),
              total: rows.length,
              next_offset: next < rows.length ? next : null,
            };
          }
          if (!artifact) return { ...base, result: null, optimization };
          const result = JSON.parse(artifact.text) as BacktestResult;
          if (input.section !== 'summary') {
            const rows = result[input.section] ?? [];
            const next = input.offset + 50;
            return {
              ...base,
              section: input.section,
              data: rows.slice(input.offset, next),
              total: rows.length,
              next_offset: next < rows.length ? next : null,
            };
          }
          return {
            ...base,
            optimization,
            result: backtestSummary(result, artifact.hash),
          };
        }),
    });
    super(tool);
  }
}

export class BacktestCancelTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const execute = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_backtest_cancel',
      title: '取消策略回测',
      description:
        '取消共享策略的回测。排队任务立即取消；运行任务提交取消请求，由后台停止，之后查询 status 确认终态。',
      inputSchema: z.object({ run_id: z.string() }),
      execute: (input, execution) =>
        execute(execution, async ({ records }, actor) => ({
          run: runView(await records.cancel(actor.userId, input.run_id)),
        })),
    });
    super(tool);
  }
}

export function createBacktestTools(
  context: PluginContext,
  get: () => QuantDependencies,
) {
  return [
    new BacktestStartTool(context, get),
    new BacktestStartTool(context, get, true),
    new BacktestListTool(context, get),
    new BacktestStatusTool(context, get),
    new BacktestResultTool(context, get),
    new BacktestCompareTool(context, get),
    new BacktestCancelTool(context, get),
  ];
}
