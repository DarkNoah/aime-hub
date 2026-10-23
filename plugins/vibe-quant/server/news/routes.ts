import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { QuantConfig } from '../config.js';
import { newsIndustries } from './catalog.js';
import type { NewsStore } from './store.js';
import { parseNewsCursor } from './query.js';

const sourceInput = z.object({
  name: z.string().trim().min(1).max(120),
  industry: z
    .string()
    .refine((value) => newsIndustries.some((item) => item.key === value)),
  url: z
    .url()
    .max(8192)
    .transform((value, ctx) => {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        ctx.addIssue({ code: 'custom', message: '请填写 HTTP(S) RSS 地址' });
        return z.NEVER;
      }
      url.hash = '';
      return url.href;
    }),
  enabled: z.boolean(),
  contentMode: z.enum(['page', 'feed']).optional(),
});
export function newsRoutes(
  get: () => { store: NewsStore; config: QuantConfig },
) {
  const api = new Hono<PluginHttpEnv>();
  api.onError((_error, c) => c.json({ code: 'NEWS_SERVICE_UNAVAILABLE' }, 503));
  api.get('/overview', async (c) => {
    const { store, config } = get();
    const [sources, collector, counts] = await Promise.all([
      store.sources(),
      store.collector(),
      store.counts(),
    ]);
    return c.json({
      industries: newsIndustries,
      sources,
      collector,
      counts,
      enabled: config.newsEnabled,
      pollSeconds: config.newsPollSeconds,
      canManage: c.get('isAdmin'),
    });
  });
  api.get('/', async (c) => {
    const parsed = z
      .object({
        industry: z.string().max(40).optional(),
        source: z.string().max(40).optional(),
        q: z.string().max(200).optional(),
        cursor: z.string().max(256).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .safeParse(c.req.query());
    if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    let before;
    try {
      before = parseNewsCursor(parsed.data.cursor);
    } catch {
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    }
    return c.json(await get().store.list({ ...parsed.data, before }));
  });
  api.get('/:id', async (c) => {
    if (!/^[a-f0-9]{64}$/.test(c.req.param('id')))
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const article = await get().store.article(c.req.param('id'));
    return article ? c.json(article) : c.json({ code: 'NOT_FOUND' }, 404);
  });
  api.patch('/sources/:id', async (c) => {
    if (!c.get('isAdmin')) return c.json({ code: 'FORBIDDEN' }, 403);
    const input = sourceInput
      .partial()
      .strict()
      .refine((value) => Object.keys(value).length > 0)
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success || !/^[a-f0-9]{24}$/.test(c.req.param('id')))
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    if (!(await get().store.source(c.req.param('id'))))
      return c.json({ code: 'NOT_FOUND' }, 404);
    const source = await get().store.updateSource(
      c.req.param('id'),
      input.data,
    );
    return source ? c.json(source) : c.json({ code: 'SOURCE_CONFLICT' }, 409);
  });
  api.post('/sources', async (c) => {
    if (!c.get('isAdmin')) return c.json({ code: 'FORBIDDEN' }, 403);
    const input = sourceInput
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const source = await get().store.createSource(input.data);
    return source
      ? c.json(source, 201)
      : c.json({ code: 'SOURCE_CONFLICT' }, 409);
  });
  api.delete('/sources/:id', async (c) => {
    if (!c.get('isAdmin')) return c.json({ code: 'FORBIDDEN' }, 403);
    if (!/^[a-f0-9]{24}$/.test(c.req.param('id')))
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return (await get().store.deleteSource(c.req.param('id')))
      ? c.json({ id: c.req.param('id') })
      : c.json({ code: 'NOT_FOUND' }, 404);
  });
  return api;
}
