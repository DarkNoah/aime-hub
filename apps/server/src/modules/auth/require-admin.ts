import type { RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { hasAdminRole } from '@aime/shared';
import type { Auth } from '@aime/auth';

export function requireAdmin(auth: Auth): RequestHandler {
  return async (req, res, next) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session)
      return res
        .status(401)
        .json({ code: 'UNAUTHORIZED', message: '请先登录' });
    if (!hasAdminRole(session.user.role))
      return res
        .status(403)
        .json({ code: 'FORBIDDEN', message: '需要管理员权限' });
    next();
  };
}
