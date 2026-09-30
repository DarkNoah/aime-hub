import { Router } from 'express';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Auth } from '@aime/auth';

export function authRoutes(auth: Auth) {
  const router = Router();
  const handler = toNodeHandler(auth);
  router.all('/auth/*splat', (req, res) => {
    // Authentication rate limits must use the socket, never a client-supplied header.
    req.headers['x-aime-client-ip'] = req.socket.remoteAddress ?? '';
    return handler(req, res);
  });
  router.get('/me', async (req, res) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) return res.status(401).json({ message: '请先登录' });
    return res.json({ user: session.user });
  });
  return router;
}
