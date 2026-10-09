import type { MiddlewareHandler } from 'hono';
import { hasAdminRole } from '@aime/shared';
import type { Auth } from '@aime/auth';
import type { HttpEnv } from '../../http.js';

export function requireAdmin(auth: Auth): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session)
      return c.json({ code: 'UNAUTHORIZED', message: '请先登录' }, 401);
    if (!hasAdminRole(session.user.role))
      return c.json({ code: 'FORBIDDEN', message: '需要管理员权限' }, 403);
    await next();
  };
}
