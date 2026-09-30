import { Router } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '@aime/auth';
import type { ProviderService } from '../providers/service.js';

export function modelRoutes(auth: Auth, service: ProviderService) {
  const router = Router();
  router.get('/models', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session)
      return res
        .status(401)
        .json({ code: 'UNAUTHORIZED', message: '请先登录' });
    return res.json(await service.listAvailableModels());
  });
  return router;
}
