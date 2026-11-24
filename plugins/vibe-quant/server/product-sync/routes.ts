import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { QuantConfig } from '../config.js';
import type { ProductSyncStore } from './store.js';

// Exchange-qualified product keys and individual contracts both come from the catalog.
const keySchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9_]+\.[A-Za-z0-9_.-]+$/);

export function productSyncRoutes(
  get: () => {
    config: Pick<QuantConfig, 'engine' | 'clickhouseReadOnly'>;
    products: Pick<ProductSyncStore, 'overview' | 'contracts' | 'setSelected'>;
  },
) {
  const api = new Hono<PluginHttpEnv>();
  api.use('*', async (c, next) => {
    if (get().config.engine !== 'tqsdk')
      return c.json({ code: 'PRODUCT_SYNC_ENGINE_UNSUPPORTED' }, 400);
    await next();
  });
  api.get('/', async (c) => {
    const { config, products } = get();
    const overview = await products.overview(config.engine, c.get('userId'));
    return c.json({ ...overview, writable: !config.clickhouseReadOnly });
  });
  api.get('/contracts', async (c) => {
    const query = z
      .object({
        product: keySchema,
        q: z.string().max(100).default(''),
        cursor: keySchema.optional(),
      })
      .safeParse(c.req.query());
    if (!query.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { config, products } = get();
    const { product, q, cursor } = query.data;
    return c.json(
      await products.contracts(
        config.engine,
        c.get('userId'),
        product,
        q,
        cursor,
      ),
    );
  });
  api.put('/', async (c) => {
    const input = z
      .strictObject({ key: keySchema, selected: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const { config, products } = get();
    const { key, selected } = input.data;
    if (
      !(await products.setSelected(
        config.engine,
        c.get('userId'),
        key,
        selected,
      ))
    )
      return c.json({ code: 'UNKNOWN_PRODUCT_OR_CONTRACT' }, 404);
    return c.json({ key, selected });
  });
  return api;
}
