import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Auth } from '@aime/auth';
import { hasAdminRole } from '@aime/shared';
import type { HttpEnv } from '../../http.js';
import { filePath } from '../files/paths.js';
import { previewFile } from '../files/service.js';
import type { SkillService } from './service.js';

export function skillFileRoutes(
  auth: Auth,
  service: SkillService,
  scope: 'global' | 'personal',
) {
  const router = new Hono<HttpEnv>();
  router.get('/raw', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (scope === 'global' && !hasAdminRole(session.user.role))
      return c.json({ code: 'FORBIDDEN' }, 403);
    const target =
      scope === 'personal' ? service.forUser(session.user.id) : service;
    return target.withFiles(c.req.query('skill') ?? '', async (root) => {
      const path = c.req.query('path') ?? '';
      const info = await previewFile(root, path);
      const absolute = await filePath(root, path);
      c.header('Content-Type', info.mime);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Content-Security-Policy', "default-src 'none'; sandbox");
      c.header('Cache-Control', 'no-store');
      if (
        c.req.query('download') === '1' ||
        info.kind === 'text' ||
        info.kind === 'binary'
      ) {
        const name = encodeURIComponent(path.split('/').at(-1)!).replace(
          /['()*]/g,
          (value) => `%${value.charCodeAt(0).toString(16)}`,
        );
        c.header(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${name}`,
        );
      }
      return serveStatic<HttpEnv>({
        path: absolute,
        onFound: (_path, context) => context.header('Content-Type', info.mime),
      })(c, next);
    });
  });
  return router;
}
