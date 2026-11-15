import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Auth } from '@aime/auth';
import { hasAdminRole } from '@aime/shared';
import { SKILL_ARCHIVE_MAX_BYTES } from '@aime/shared/skills';
import type { HttpEnv } from '../../http.js';
import { filePath } from '../files/paths.js';
import { previewFile } from '../files/service.js';
import type { SkillService } from './service.js';
import { SkillError } from './errors.js';

export function skillArchiveRoutes(
  auth: Auth,
  service: SkillService,
  scope: 'global' | 'personal',
  webOrigins: readonly string[],
) {
  const router = new Hono<HttpEnv>();
  router.use('/archives', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (
      (scope === 'global' && !hasAdminRole(session.user.role)) ||
      !webOrigins.includes(c.req.header('Origin') ?? '')
    )
      return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('userId', session.user.id);
    await next();
  });
  router.post(
    '/archives',
    bodyLimit({
      maxSize: SKILL_ARCHIVE_MAX_BYTES + 64 * 1024,
      onError: (c) => c.json({ code: 'SKILL_ARCHIVE_TOO_LARGE' }, 413),
    }),
    async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ code: 'SKILL_ARCHIVE_INVALID' }, 400);
      }
      const file = form.get('file');
      if (!(file instanceof File) || form.getAll('file').length !== 1)
        return c.json({ code: 'SKILL_ARCHIVE_INVALID' }, 400);
      if (file.size > SKILL_ARCHIVE_MAX_BYTES)
        return c.json({ code: 'SKILL_ARCHIVE_TOO_LARGE' }, 413);
      const target =
        scope === 'personal' ? service.forUser(c.get('userId')) : service;
      try {
        const scan = await target.scanArchive(
          file.name,
          Buffer.from(await file.arrayBuffer()),
          c.req.raw.signal,
        );
        if (c.req.raw.signal.aborted) {
          await target.discard(scan.id);
          return c.json({ code: 'ABORTED', message: '用户中止了操作' }, 400);
        }
        return c.json(scan);
      } catch (error) {
        if (c.req.raw.signal.aborted)
          return c.json({ code: 'ABORTED', message: '用户中止了操作' }, 400);
        if (error instanceof SkillError)
          return c.json(
            { code: error.code },
            error.status as ContentfulStatusCode,
          );
        throw error;
      }
    },
  );
  return router;
}

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
