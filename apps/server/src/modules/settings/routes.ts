import { Router } from 'express';
import { modelDefaultsSchema } from '@aime/shared/providers';
import type { ProviderService } from '../providers/service.js';

// Validation of references stays in ProviderService, beside model availability rules.
export function settingsRoutes(service: ProviderService) {
  const router = Router();
  router.get('/models', async (_req, res) => {
    res.json(await service.getDefaults());
  });
  router.put('/models', async (req, res) => {
    res.json(await service.setDefaults(modelDefaultsSchema.parse(req.body)));
  });
  return router;
}
