import { Hono } from 'hono';
import type { HttpEnv } from '../../http.js';
import type { LocalApiAccess } from '../auth/local-api.js';
import { generateLocalApiSpec } from './catalog.js';

export function localApiRoutes(access: LocalApiAccess) {
  const router = new Hono<HttpEnv>();
  let spec: ReturnType<typeof generateLocalApiSpec> | undefined;
  router.get('/openapi.json', async (c) => {
    const userId = await access.authenticate(
      c.req.header('authorization') ?? '',
    );
    if (!userId) return c.json({ code: 'UNAUTHORIZED' }, 401);
    // Cache only the static schema. Authentication is checked on every request.
    spec ??= generateLocalApiSpec().catch((error) => {
      spec = undefined;
      throw error;
    });
    return c.json(await spec);
  });
  return router;
}
