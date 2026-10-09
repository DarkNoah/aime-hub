import type { HttpBindings } from '@hono/node-server';
import type { Auth } from '@aime/auth';
import type { MiddlewareHandler } from 'hono';

export type HttpEnv = { Bindings: HttpBindings; Variables: { userId: string } };

export function requireSession(auth: Auth): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session)
      return c.json({ code: 'UNAUTHORIZED', message: '请先登录' }, 401);
    c.set('userId', session.user.id);
    await next();
  };
}
