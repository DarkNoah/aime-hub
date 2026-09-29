import express from 'express';
import helmet from 'helmet';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { hasAdminRole } from '@aime/shared';
import type { Auth } from '@aime/auth';

import { providerRoutes } from './provider-routes.js';
import type { ProviderService } from './provider-service.js';

export function createApp(
  auth: Auth,
  providers?: { service: ProviderService; webOrigin: string },
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.all('/api/auth/*splat', (req, res) => {
    // Overwrite, never trust a client-supplied address for authentication rate limits.
    req.headers['x-aime-client-ip'] = req.socket.remoteAddress ?? '';
    return toNodeHandler(auth)(req, res);
  });
  app.get('/api/me', async (req, res) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) return res.status(401).json({ message: '请先登录' });
    return res.json({ user: session.user });
  });
  app.use('/api/admin', async (req, res, next) => {
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
  });
  if (providers)
    app.use(
      '/api/admin',
      providerRoutes(providers.service, providers.webOrigin),
    );
  app.use('/api/admin', (_req, res) =>
    res.status(501).json({ message: '该管理模块尚未实现' }),
  );
  app.use((_req, res) => res.status(404).json({ message: '接口不存在' }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return _next(error);
      console.error(
        '请求处理失败',
        error instanceof Error ? error.name : 'UnknownError',
      );
      res.status(500).json({ message: '服务暂时不可用，请稍后重试' });
    },
  );
  return app;
}
