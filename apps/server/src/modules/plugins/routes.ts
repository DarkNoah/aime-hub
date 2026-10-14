import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Auth } from '@aime/auth';
import { hasAdminRole } from '@aime/shared';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import { PluginError, type PluginService } from './service.js';

export function pluginRoutes(
  auth: Auth,
  plugins: PluginService,
  origins: readonly string[],
) {
  const app = new Hono<PluginHttpEnv>();
  app.use('*', bodyLimit({ maxSize: 128 * 1024 }));
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !origins.includes(c.req.header('origin') ?? '')
    )
      return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('userId', session.user.id);
    c.set('isAdmin', hasAdminRole(session.user.role));
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/', async (c) =>
    c.json((await plugins.list()).filter((p) => c.get('isAdmin') || p.enabled)),
  );
  app.put('/:id/enabled', async (c) => {
    if (!c.get('isAdmin')) return c.json({ code: 'FORBIDDEN' }, 403);
    const body = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await plugins.setEnabled(c.req.param('id'), body.data.enabled),
    );
  });
  for (const { manifest } of plugins.definitions) {
    app.use(`/${manifest.id}/*`, async (_c, next) => {
      await plugins.assertEnabled(manifest.id);
      await next();
    });
    const api = plugins.api(manifest.id);
    if (api) app.route(`/${manifest.id}`, api);
  }
  app.onError((error, c) => {
    if (error instanceof PluginError)
      return c.json({ code: error.code }, error.status as 404 | 409);
    console.error(
      'Plugin request failed',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return c.json({ code: 'INTERNAL_ERROR' }, 500);
  });
  return app;
}
