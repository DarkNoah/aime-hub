import { Router } from 'express';

export function healthRoutes() {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  return router;
}
