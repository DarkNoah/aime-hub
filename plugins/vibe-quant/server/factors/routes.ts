import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import {
  analysisSchema,
  factorId,
  FactorError,
  factorSchema,
} from './schema.js';
import type { FactorStore } from './store.js';
import type { FactorService } from './service.js';

export function factorRoutes(
  context: PluginContext,
  get: () => { records: FactorStore; service: FactorService },
) {
  const api = new Hono<PluginHttpEnv>();
  api.onError((error, c) => {
    if (error instanceof FactorError)
      return c.json({ code: error.message }, error.status);
    return c.json(
      {
        code: 'FACTOR_SERVICE_UNAVAILABLE',
        message: '因子服务暂不可用，请稍后重试',
      },
      503,
    );
  });
  // User Python is not a security sandbox. Match strategy execution's admin boundary,
  // including publication: a non-admin must not inject code into an admin's strategy.
  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && !c.get('isAdmin'))
      return c.json(
        {
          code: 'ADMIN_REQUIRED',
          message: '仅管理员可以修改和执行 Python 因子',
        },
        403,
      );
    await next();
  });
  api.get('/template', async (c) =>
    c.json({
      canRun: c.get('isAdmin'),
      source: await readFile(
        join(context.runtime.paths.pluginRoot, 'sdk/templates/factor.py'),
        'utf8',
      ),
      parameters: { window: 20 },
    }),
  );
  api.get('/', async (c) => c.json(await get().records.list()));
  api.post('/', async (c) => {
    const input = factorSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new FactorError('请检查名称、Python 源码和参数');
    return c.json(await get().records.save(c.get('userId'), input.data), 201);
  });
  api.get('/analyses/:runId', async (c) =>
    c.json(await get().records.analysis(factorId(c.req.param('runId')))),
  );
  api.get('/:id', async (c) =>
    c.json(await get().records.detail(factorId(c.req.param('id')))),
  );
  api.put('/:id', async (c) => {
    const input = factorSchema
      .extend({ revision: z.number().int().positive() })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new FactorError('请检查名称、Python 源码和参数');
    return c.json(
      await get().records.save(
        c.get('userId'),
        input.data,
        factorId(c.req.param('id')),
        input.data.revision,
      ),
    );
  });
  api.post('/:id/versions', async (c) => {
    const input = z
      .object({
        revision: z.number().int().positive(),
        note: z.string().max(2000).default(''),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new FactorError('版本参数无效');
    const id = factorId(c.req.param('id'));
    const row = await get().records.detail(id);
    if (row.revision !== input.data.revision)
      throw new FactorError('记录已被修改，请重新加载后发布', 409);
    try {
      await get().service.validate(
        row.source,
        row.parameters,
        c.req.raw.signal,
      );
    } catch (error) {
      throw new FactorError(
        c.req.raw.signal.aborted
          ? '用户中止了操作'
          : error instanceof Error
            ? error.message
            : '因子校验失败',
      );
    }
    return c.json(
      await get().records.publish(
        c.get('userId'),
        id,
        input.data.revision,
        input.data.note,
      ),
      201,
    );
  });
  api.get('/:id/analyses', async (c) =>
    c.json(await get().records.analyses(factorId(c.req.param('id')))),
  );
  api.post('/:id/analyses', async (c) => {
    const input = analysisSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      throw new FactorError(input.error.issues[0]?.message ?? '分析参数无效');
    return c.json(
      await get().service.analyze(
        c.get('userId'),
        factorId(c.req.param('id')),
        input.data,
        c.req.raw.signal,
      ),
      201,
    );
  });
  return api;
}
