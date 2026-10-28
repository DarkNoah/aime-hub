import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { PluginTool, type PluginContext } from '@app/plugin-sdk/server';
import { z } from 'zod';
import {
  analysisSchema,
  factorSchema,
  FactorError,
} from '../../server/factors/schema.js';
import { quantToolContext, type QuantDependencies } from './context.js';

function dependencies(deps: QuantDependencies) {
  if (!deps.factors || !deps.factorService)
    throw new FactorError('因子服务尚未就绪');
  return { records: deps.factors, service: deps.factorService };
}
function admin(actor: { isAdmin: boolean }) {
  if (!actor.isAdmin)
    throw new FactorError('仅管理员可以修改和执行 Python 因子', 403);
}

export function createFactorTools(
  context: PluginContext,
  get: () => QuantDependencies,
) {
  const run = quantToolContext(context, get);
  class FactorGuide extends PluginTool {
    constructor() {
      super(
        createTool({
          id: 'plugin_vibe_quant_factor_guide',
          title: '因子编写指南',
          description:
            '编写 Python 期货因子前读取 SDK、模板、分析口径和策略调用方式。',
          inputSchema: z.object({}),
          execute: (_, execution) =>
            run(execution, async (_deps, actor, signal) => {
              const root = context.runtime.paths.pluginRoot;
              const [reference, source] = await Promise.all([
                readFile(join(root, 'sdk/FACTORS.md'), {
                  encoding: 'utf8',
                  signal,
                }),
                readFile(join(root, 'sdk/templates/factor.py'), {
                  encoding: 'utf8',
                  signal,
                }),
              ]);
              return {
                can_run: actor.isAdmin,
                reference,
                template: { source, parameters: { window: 20 } },
              };
            }),
        }),
      );
    }
  }
  class FactorRead extends PluginTool {
    constructor() {
      super(
        createTool({
          id: 'plugin_vibe_quant_factor_read',
          title: '查询因子库',
          description:
            '不传 ID 返回因子列表；factor_id 读取草稿与版本目录，version_id 读取固定版本，analysis_id 读取分析结果摘要。',
          inputSchema: z.object({
            factor_id: z.string().optional(),
            version_id: z.string().optional(),
            analysis_id: z.string().optional(),
          }),
          execute: (input, execution) =>
            run(execution, async (deps) => {
              const { records } = dependencies(deps);
              if (input.analysis_id) {
                const row = await records.analysis(input.analysis_id);
                return {
                  id: row.id,
                  status: row.status,
                  message: row.message,
                  config: row.config,
                  source_hash: row.source_hash,
                  parameters: row.parameters,
                  metrics: row.report?.metrics,
                  groups: row.report?.groups,
                  latest: row.report?.latest,
                  coverage: row.report?.coverage,
                  warnings: row.report?.warnings,
                  methodology: row.report?.methodology,
                };
              }
              if (input.version_id) return records.version(input.version_id);
              if (!input.factor_id) return { factors: await records.list() };
              const row = await records.detail(input.factor_id);
              return {
                ...row,
                versions: row.versions.map((v) => ({
                  id: v.id,
                  number: v.number,
                  source_hash: v.source_hash,
                  parameters: v.parameters,
                  note: v.note,
                  created_at: v.created_at,
                })),
                analyses: await records.analyses(row.id),
              };
            }),
        }),
      );
    }
  }
  class FactorSave extends PluginTool {
    constructor() {
      super(
        createTool({
          id: 'plugin_vibe_quant_factor_save',
          title: '保存 Python 因子',
          description:
            '创建因子或更新已读取的草稿。更新时传 factor_id 和 revision；代码及 parameters 整体替换。',
          inputSchema: factorSchema.extend({
            factor_id: z.string().optional(),
            revision: z.number().optional(),
          }),
          execute: (input, execution) =>
            run(execution, async (deps, actor, signal) => {
              admin(actor);
              signal?.throwIfAborted();
              if (
                input.factor_id &&
                (!Number.isInteger(input.revision) ||
                  !input.revision ||
                  input.revision < 1)
              )
                throw new FactorError('更新前请读取因子的 revision');
              return dependencies(deps).records.save(
                actor.userId,
                input,
                input.factor_id,
                input.revision,
              );
            }),
        }),
      );
    }
  }
  class FactorPublish extends PluginTool {
    constructor() {
      super(
        createTool({
          id: 'plugin_vibe_quant_factor_publish',
          title: '发布因子版本',
          description:
            '校验 Python 因子入口并发布不可变版本，供策略使用 load_factor("版本ID") 调用。',
          inputSchema: z.object({
            factor_id: z.string(),
            revision: z.number(),
            note: z.string().default(''),
          }),
          execute: (input, execution) =>
            run(execution, async (deps, actor, signal) => {
              admin(actor);
              const { records, service } = dependencies(deps);
              const row = await records.detail(input.factor_id);
              if (row.revision !== input.revision)
                throw new FactorError('因子已修改，请重新读取', 409);
              try {
                await service.validate(
                  row.source,
                  row.parameters,
                  signal ?? new AbortController().signal,
                );
              } catch (error) {
                throw new FactorError(
                  error instanceof Error ? error.message : '校验失败',
                );
              }
              signal?.throwIfAborted();
              const next = await records.publish(
                actor.userId,
                row.id,
                input.revision,
                input.note,
              );
              return {
                factor_id: row.id,
                revision: next.revision,
                version: next.versions[0],
              };
            }),
        }),
      );
    }
  }
  class FactorAnalyze extends PluginTool {
    constructor() {
      super(
        createTool({
          id: 'plugin_vibe_quant_factor_analyze',
          title: '运行期货因子分析',
          description:
            '对已有期货日线运行横截面分析。日期 YYYY-MM-DD，至少 3 个合约且不少于分组数；未传 version_id 使用当前已保存草稿。同步等待结果，中止信号会停止任务。',
          inputSchema: analysisSchema.safeExtend({ factor_id: z.string() }),
          execute: (input, execution) =>
            run(execution, async (deps, actor, signal) => {
              admin(actor);
              const row = await dependencies(deps).service.analyze(
                actor.userId,
                input.factor_id,
                input,
                signal ?? new AbortController().signal,
              );
              return {
                analysis_id: row.id,
                factor_id: row.factor_id,
                status: row.status,
                message: row.message,
                config: row.config,
                metrics: row.report?.metrics,
                groups: row.report?.groups,
                warnings: row.report?.warnings,
                methodology: row.report?.methodology,
              };
            }),
        }),
      );
    }
  }
  return [
    new FactorGuide(),
    new FactorRead(),
    new FactorSave(),
    new FactorPublish(),
    new FactorAnalyze(),
  ];
}
