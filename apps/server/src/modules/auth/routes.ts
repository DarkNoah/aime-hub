import { Hono } from 'hono';
import type { Auth } from '@aime/auth';
import type { HttpEnv } from '../../http.js';
import type { SystemSettingsService } from '../system-settings/service.js';

export function authRoutes(auth: Auth, settings?: SystemSettingsService) {
  const router = new Hono<HttpEnv>();
  router.get('/auth/registration-status', async (c) => {
    c.header('Cache-Control', 'no-store');
    const registrationEnabled = settings
      ? (await settings.get()).registrationEnabled
      : true;
    return c.json({ registrationEnabled });
  });
  router.on(['GET', 'POST'], '/auth/*', (c) => {
    const headers = new Headers(c.req.raw.headers);
    // Override client input with the socket address used by Better Auth rate limits.
    headers.set(
      'x-aime-client-ip',
      c.env?.incoming?.socket.remoteAddress ?? '',
    );
    return auth.handler(new Request(c.req.raw, { headers }));
  });
  router.get('/me', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ message: '请先登录' }, 401);
    return c.json({ user: session.user });
  });
  return router;
}
