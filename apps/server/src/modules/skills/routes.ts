import { Router, type ErrorRequestHandler } from 'express';
import {
  scanSkillsSchema,
  installSkillsSchema,
  removeSkillSchema,
  removeSkillGroupSchema,
} from '@aime/shared/skills';
import type { SkillService } from './service.js';
import { SkillError } from './errors.js';

// Mounted after the admin session, same-origin, and JSON middleware.
export function skillRoutes(service: SkillService) {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json(await service.list());
  });
  router.post('/scans', async (req, res) => {
    const { url } = scanSkillsSchema.parse(req.body);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on('close', cancel);
    try {
      res.json(await service.scan(url, controller.signal));
    } finally {
      res.off('close', cancel);
    }
  });
  router.delete('/scans/:id', async (req, res) => {
    await service.discard(req.params.id);
    res.sendStatus(204);
  });
  router.post('/install', async (req, res) => {
    const { scanId, paths } = installSkillsSchema.parse(req.body);
    res.status(201).json(await service.install(scanId, paths));
  });
  router.delete('/', async (req, res) => {
    await service.remove(removeSkillSchema.parse(req.body).path);
    res.sendStatus(204);
  });
  router.delete('/groups', async (req, res) => {
    const { group, paths } = removeSkillGroupSchema.parse(req.body);
    res.json(await service.removeGroup(group, paths));
  });
  router.use(((error, _req, res, next) => {
    if (error instanceof SkillError)
      return res.status(error.status).json({ code: error.code });
    next(error);
  }) satisfies ErrorRequestHandler);
  return router;
}
