import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { Auth } from '@aime/auth';
import { AVATAR_MAX_BYTES } from '@aime/shared/profile';
import { requireSession, type HttpEnv } from '../../http.js';
import { AvatarError, type AvatarService } from './avatars.js';

export function avatarResourceRoutes(service: AvatarService) {
  const router = new Hono<HttpEnv>();
  router.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Access-Control-Allow-Origin', '*');
    await next();
  });
  router.on(['GET', 'HEAD'], '/:filename', async (c) => {
    const resource = await service.read(c.req.param('filename'));
    if (!resource) return c.notFound();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('ETag', resource.etag);
    c.header('Last-Modified', resource.modified);
    const etags = c.req.header('If-None-Match');
    if (
      etags
        ? etags.split(',').some((value) => {
            const tag = value.trim().replace(/^W\//, '');
            return tag === '*' || tag === resource.etag;
          })
        : Date.parse(c.req.header('If-Modified-Since') ?? '') >=
          Date.parse(resource.modified)
    )
      return c.body(null, 304);
    c.header('Content-Type', 'image/webp');
    c.header('Content-Length', String(resource.data.length));
    if (c.req.method === 'HEAD') return c.body(null, 200);
    return c.body(new Uint8Array(resource.data), 200);
  });
  return router;
}

export function profileRoutes(
  auth: Auth,
  service: AvatarService,
  webOrigins: readonly string[],
) {
  const router = new Hono<HttpEnv>();
  router.use('*', requireSession(auth));
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!webOrigins.includes(c.req.header('Origin') ?? ''))
      return c.json({ code: 'FORBIDDEN' }, 403);
    await next();
  });
  router.post(
    '/avatar',
    bodyLimit({
      maxSize: AVATAR_MAX_BYTES + 64 * 1024,
      onError: (c) => c.json({ code: 'AVATAR_TOO_LARGE' }, 413),
    }),
    async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ code: 'AVATAR_INVALID' }, 400);
      }
      const file = form.get('file');
      if (!(file instanceof File) || !file.size)
        return c.json({ code: 'AVATAR_INVALID' }, 400);
      if (file.size > AVATAR_MAX_BYTES)
        return c.json({ code: 'AVATAR_TOO_LARGE' }, 413);
      try {
        const path = await service.upload(
          Buffer.from(await file.arrayBuffer()),
          c.req.raw.signal,
        );
        return c.json({ url: new URL(path, c.req.header('Origin')!).href });
      } catch (error) {
        if (c.req.raw.signal.aborted)
          return c.json({ code: 'ABORTED', message: '用户中止了操作' }, 400);
        if (error instanceof AvatarError)
          return c.json(
            { code: error.code },
            error.code === 'AVATAR_TOO_LARGE' ? 413 : 400,
          );
        throw error;
      }
    },
  );
  return router;
}
