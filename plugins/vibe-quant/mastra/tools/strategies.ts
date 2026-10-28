import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PluginTool, type PluginContext } from '@app/plugin-sdk/server';
import {
  strategySchema,
  StrategyError,
} from '../../server/strategies/schema.js';
import { quantToolContext, type QuantDependencies } from './context.js';

const id = z.string().describe('工具返回的策略 ID');
const parameters = z.record(z.string(), z.unknown());

export class StrategyGuideTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_strategy_guide',
      title: '策略编写指南',
      description:
        '读取当前 quant_sdk 文档、空白 Python 模板和回测权限。编写或修改策略前先调用。',
      inputSchema: z.object({}),
      execute: (_input, execution) =>
        run(execution, async (_deps, actor, signal) => {
          const root = context.runtime.paths.pluginRoot;
          const [reference, source] = await Promise.all([
            readFile(join(root, 'sdk/README.md'), { encoding: 'utf8', signal }),
            readFile(join(root, 'sdk/templates/strategy.py'), {
              encoding: 'utf8',
              signal,
            }),
          ]);
          return {
            can_run: actor.isAdmin,
            runtime: 'plugin-venv',
            reference,
            template: {
              source,
              parameters: {},
            },
            workflow:
              'create/update → publish → backtest_start → backtest_status → backtest_result。策略及回测在同一数据库内共享，已发布版本不可变。',
            backtest: {
              engines: {
                builtin: '默认；已保存历史快照与内置 PaperBroker。',
                tqsdk:
                  'backtest_engine=tqsdk；TqBacktest 历史行情 + TqSim 本地账户。仅支持单个期货实际合约；可输入已到期合约。rules 与 participation_rate 不适用；tq_options.commission_per_lot / margin_per_lot 为每手金额覆盖，省略使用 TqSim 默认。需要插件配置天勤账号；暂不支持主连、点数、调优、自定义日历或其他基准标的。',
              },
              durations: [60, 180, 300, 900, 1800, 3600, 86400],
              time: 'start/end 为 UTC epoch 秒；单次区间不超过十年，仅回测已有历史数据。',
              rules:
                '内置资金回测 rules 必填：multiplier、margin_rate、lot_size、t_plus_one、fees（per_unit/rate/minimum/close_today_per_unit/close_today_rate/sell_tax_rate）。fees.mode 可选 fixed、rate、combined（省略时沿用）。最低费用和卖出税费始终生效。所有费率用小数；平今字段可为 null。天勤引擎使用 tq_options 与原生合约信息；不适用 rules。',
              data: '内置引擎仅使用已采集数据，主连需要历史映射和实际合约 K 线。天勤引擎直接获取供应商历史数据并保存快照；兼容原 Strategy 回调，但撮合和保护单按回放报价执行，结果可能不同。暂不支持期权回测。',
            },
          };
        }),
    });
    super(tool);
  }
}

export class InstrumentSearchTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_instrument_search',
      title: '查找量化标的',
      description:
        '搜索当前引擎的合约目录；symbol 可精确读取含过期合约的元数据。返回值不包含完整手续费或保证金规则。',
      inputSchema: z.object({
        query: z.string().default(''),
        symbol: z.string().optional(),
      }),
      execute: (input, execution) =>
        run(execution, async ({ state, config }) => ({
          engine: config.engine,
          instruments: input.symbol
            ? [await state.instrument(config.engine, input.symbol)].filter(
                (item) => item !== null,
              )
            : await state.search(config.engine, input.query, 'all'),
        })),
    });
    super(tool);
  }
}

export class StrategyListTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_strategy_list',
      title: '查询策略列表',
      description:
        '查询共享策略摘要（含 ID、revision、启用状态、版本数），可按名称或描述筛选。',
      inputSchema: z.object({
        query: z.string().default(''),
        offset: z.number().int().nonnegative().default(0),
      }),
      execute: (input, execution) =>
        run(execution, async ({ records }, actor) => {
          const query = input.query.trim().toLocaleLowerCase();
          const items = (await records.list(actor.userId)).filter((item) =>
            `${item.name}\n${item.description}`
              .toLocaleLowerCase()
              .includes(query),
          );
          const next = input.offset + 50;
          return {
            strategies: items.slice(input.offset, next),
            total: items.length,
            next_offset: next < items.length ? next : null,
          };
        }),
    });
    super(tool);
  }
}

export class StrategyReadTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_strategy_read',
      title: '读取策略',
      description:
        '读取共享策略的草稿源码、参数及 revision；可附带 version_id 读取指定不可变版本。更新前必须读取。',
      inputSchema: z.object({
        strategy_id: id,
        version_id: z.string().optional(),
      }),
      execute: (input, execution) =>
        run(execution, async ({ records }, actor, signal) => {
          const strategy = await records.detail(
            actor.userId,
            input.strategy_id,
          );
          signal?.throwIfAborted();
          const version = input.version_id
            ? await records.version(actor.userId, input.version_id)
            : undefined;
          if (version && version.strategy_id !== strategy.id)
            throw new StrategyError('VERSION_NOT_FOUND', 404);
          return { strategy, ...(version ? { version } : {}) };
        }),
    });
    super(tool);
  }
}

export class StrategyCreateTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_strategy_create',
      title: '创建策略草稿',
      description:
        '创建 Python 策略草稿。只需 name 和完整 source，parameters 可选；自动识别 Strategy 子类，保存不执行代码。',
      inputSchema: z.object({
        name: z.string(),
        source: z.string().describe('完整 Python 策略源码'),
        parameters: parameters.default({}),
        description: z.string().default(''),
        enabled: z.boolean().default(true),
      }),
      execute: (input, execution) =>
        run(execution, async ({ records }, actor) => ({
          strategy: await records.save(
            actor.userId,
            strategySchema.parse({
              name: input.name,
              description: input.description,
              enabled: input.enabled,
              draft: { source: input.source, parameters: input.parameters },
            }),
          ),
        })),
    });
    super(tool);
  }
}

export class StrategyUpdateTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_strategy_update',
      title: '更新策略草稿',
      description:
        '按读取到的 revision 更新策略，只传要改的字段。source 是完整源码，parameters 整体替换；enabled 控制新回测。冲突时重新读取。',
      inputSchema: z.strictObject({
        strategy_id: id,
        revision: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        source: z.string().optional(),
        parameters: parameters.optional(),
      }),
      execute: (input, execution) =>
        run(execution, async ({ records }, actor, signal) => {
          const current = await records.detail(actor.userId, input.strategy_id);
          if (current.revision !== input.revision)
            throw new StrategyError('STRATEGY_CONFLICT', 409);
          const value = strategySchema.parse({
            name: input.name ?? current.name,
            description: input.description ?? current.description,
            enabled: input.enabled ?? current.enabled,
            draft: {
              source: input.source ?? current.draft.source,
              parameters: input.parameters ?? current.draft.parameters,
            },
          });
          signal?.throwIfAborted();
          return {
            strategy: await records.save(
              actor.userId,
              value,
              current.id,
              input.revision,
            ),
          };
        }),
    });
    super(tool);
  }
}

export class StrategyVersionsTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_strategy_versions',
      title: '查询策略版本',
      description:
        '列出策略的不可变版本摘要和参数；需要源码时用 strategy_read 指定 version_id。',
      inputSchema: z.object({ strategy_id: id }),
      execute: (input, execution) =>
        run(execution, async ({ records }, actor) => ({
          versions: (
            await records.versions(actor.userId, input.strategy_id)
          ).map((version) => ({
            id: version.id,
            strategy_id: version.strategy_id,
            number: version.number,
            source_hash: version.source_hash,
            parameters: version.parameters,
            note: version.note,
            created_at: version.created_at,
          })),
        })),
    });
    super(tool);
  }
}

export class StrategyPublishTool extends PluginTool {
  constructor(context: PluginContext, get: () => QuantDependencies) {
    const run = quantToolContext(context, get);
    const tool = createTool({
      id: 'plugin_vibe_quant_strategy_publish',
      title: '保存策略版本',
      description:
        '将给定 revision 的草稿保存为不可变回测版本，返回新 revision 和 version_id。保存版本不会执行脚本或启动实盘。',
      inputSchema: z.object({
        strategy_id: id,
        revision: z.number().int().positive(),
        note: z.string().max(2000).default(''),
      }),
      execute: (input, execution) =>
        run(execution, ({ records }, actor) =>
          records.publish(
            actor.userId,
            input.strategy_id,
            input.revision,
            input.note,
          ),
        ),
    });
    super(tool);
  }
}

export function createStrategyTools(
  context: PluginContext,
  get: () => QuantDependencies,
) {
  return [
    new StrategyGuideTool(context, get),
    new InstrumentSearchTool(context, get),
    new StrategyListTool(context, get),
    new StrategyReadTool(context, get),
    new StrategyCreateTool(context, get),
    new StrategyUpdateTool(context, get),
    new StrategyVersionsTool(context, get),
    new StrategyPublishTool(context, get),
  ];
}
