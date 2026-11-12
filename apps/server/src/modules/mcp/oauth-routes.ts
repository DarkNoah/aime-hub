import { Hono } from 'hono';
import type { Auth } from '@aime/auth';
import { hasAdminRole } from '@aime/shared';
import type { McpService } from './service.js';
import type { HttpEnv } from '../../http.js';

export function mcpOAuthRoutes(auth: Auth, service: McpService) {
  const app = new Hono<HttpEnv>();
  app.get('/callback', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session)
      return c.text(
        '请先登录发起授权的账号，再重新授权。 Sign in with the account that started authorization and try again.',
        401,
      );
    try {
      const query = c.req.query();
      const result = await service.finishOAuth(
        session.user.id,
        {
          state: query.state,
          code: query.code,
          error: query.error,
          iss: query.iss,
        },
        hasAdminRole(session.user.role),
      );
      const target = new URL(result.returnTo, result.origin);
      target.searchParams.set('mcp_oauth', result.outcome);
      target.searchParams.set('server', result.serverId);
      return c.redirect(target.toString(), 303);
    } catch {
      // Never reflect provider-controlled errors, authorization codes or URLs.
      return c.text(
        '授权链接已失效或无法完成授权，请返回原页面重新登录授权。 Authorization expired or could not be completed. Return to the original page and try again.',
        400,
      );
    }
  });
  return app;
}
