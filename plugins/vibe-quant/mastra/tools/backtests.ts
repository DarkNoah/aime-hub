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
import { optimizationSchema } from '../../server/strategies/optimization.js';
import type { OptimizationReport } from '../../optimization-types.js';
import { quantToolContext, type QuantDependencies } from './context.js';
import { BacktestCompareTool } from './backtest-compare.js';
import { adoptBacktest } from './backtest-background.js';

function runView(run: BacktestRun): BacktestRun {
  return {
    ...(run.optimization_draft_id
      ? { optimization_draft_id: run.optimization_draft_id }
      : {}),
    id: run.id,
    strategy_id: run.strategy_id,
    version_id: run.version_id,
    version_number: run.version_number,
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

export const agentBacktestSchema = z.object({
  backtest_engine: z
    .enum(['builtin', 'tqsdk'])
    .optional()
    .describe(
      '默认 builtin；tqsdk 使用 TqBacktest + TqSim，仅支持单个期货实际合约，不支持主连、点数和调优。',
    ),
  tq_options: backtestSchema.shape.tq_options.describe(
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
      title: optimize ? '提交后台调优任务' : '提交后台回测任务',
      background: {
        enabled: true,
        defaultDisposition: 'deferred',
        // Includes queueing, snapshot preparation and up to 65 minutes of optimization.
        timeoutMs: 4 * 60 * 60 * 1000,
        // Enqueue is not idempotent: a retry must never create a duplicate run.
        maxRetries: 0,
      },
      description: optimize
        ? '管理员提交独立的 Optuna 参数调优任务，默认由原生后台任务执行，不阻塞对话；后台任务持续到调优结束，成功后以最佳参数自动新建一个未发布的策略草稿，不覆盖原策略。提供 version_id、symbol、start、end、rules 和 optimization.search_space。默认 30 次、600 秒、TPE 种子 42；可设置 validation_start 留出验证。调优不列入普通回测历史。告知用户后台任务已启动，不在本轮持续轮询；收到完成结果后用 backtest_result 读取报告，optimization_draft_id 指向新草稿。后续按需用 backtest_status/result/cancel 查询或取消回测 run_id。'
        : '管理员提交历史回测，默认由原生后台任务执行，不阻塞对话；后台任务持续到回测结束。默认内置引擎需要 version_id、symbol、start、end、rules。backtest_engine=tqsdk 使用天勤历史行情和 TqSim，仅支持单个期货实际合约；rules 可省略，tq_options 可覆盖每手手续费和保证金。默认资金 100 万、1 分钟 K 线、滑点 1 tick；内置引擎参与率 10%。告知用户后台任务已启动，不在本轮持续轮询；收到完成结果后用 backtest_result 读取指标和日志。后续按需用 backtest_status/result/cancel 查询或取消回测 run_id。',
      inputSchema: optimize
        ? agentBacktestSchema.extend({ optimization: optimizationSchema })
        : agentBacktestSchema,
      execute: (input, execution) =>
        execute(execution, async (deps, actor, signal) => {
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
          adoptBacktest(execution, deps.records, actor.userId, run, runView);
          return {
            run_id: run.id,
            message: `${optimize ? '调优' : '回测'}任务已提交。后续可用 backtest_status/result 查询回测 run_id，或用 backtest_cancel 取消。`,
            run: runView(run),
          };
        }),
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
        strategy_id: z.uuid(),
        before: z.uuid().optional(),
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
        '按需查询共享回测或调优任务状态，默认立即返回。wait=true 时最多等待 10 秒或直至结束；原生后台任务会跟踪完成，无需持续轮询。中止此等待不会取消后台回测。',
      inputSchema: z.object({
        run_id: z.uuid(),
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
        run_id: z.uuid(),
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
        offset: z.number().int().nonnegative().default(0),
      }),
      execute: (input, execution) =>
        execute(execution, async ({ records }, actor, signal) => {
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
            result: {
              status: result.status,
              pnl_unit: result.pnl_unit ?? 'currency',
              message: result.message,
              metrics: result.metrics,
              metric_notes: result.metric_notes,
              account: result.account,
              monthly_returns: result.monthly_returns,
              yearly_returns: result.yearly_returns,
              counts: Object.fromEntries(
                (
                  [
                    'trades',
                    'orders',
                    'fills',
                    'signals',
                    'logs',
                    'equity_curve',
                    'risk_levels',
                  ] as const
                ).map((key) => [key, result[key]?.length ?? 0]),
              ),
              logs: result.logs.slice(-20),
              result_hash: artifact.hash,
            },
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
      inputSchema: z.object({ run_id: z.uuid() }),
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
