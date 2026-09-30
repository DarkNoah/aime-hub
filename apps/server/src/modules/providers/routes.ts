import { Router } from 'express';
import {
  providerInputSchema,
  providerUpdateSchema,
  modelInputSchema,
  modelUpdateSchema,
} from '@aime/shared/providers';
import { ProviderService } from './service.js';

export function providerRoutes(service: ProviderService) {
  const router = Router();
  router.get('/providers', async (_req, res) => {
    res.json(await service.listProviders());
  });
  router.post('/providers', async (req, res) => {
    res
      .status(201)
      .json(await service.createProvider(providerInputSchema.parse(req.body)));
  });
  router.get('/providers/:providerId', async (req, res) => {
    res.json(await service.getPublicProvider(req.params.providerId));
  });
  router.patch('/providers/:providerId', async (req, res) => {
    res.json(
      await service.updateProvider(
        req.params.providerId,
        providerUpdateSchema.parse(req.body),
      ),
    );
  });
  router.delete('/providers/:providerId', async (req, res) => {
    await service.deleteProvider(req.params.providerId);
    res.sendStatus(204);
  });
  router.get('/providers/:providerId/models', async (req, res) => {
    res.json((await service.getPublicProvider(req.params.providerId)).models);
  });
  router.post('/providers/:providerId/models', async (req, res) => {
    res
      .status(201)
      .json(
        await service.createModel(
          req.params.providerId,
          modelInputSchema.parse(req.body),
        ),
      );
  });
  router.patch('/providers/:providerId/models', async (req, res) => {
    const id = modelInputSchema.shape.id.parse(req.query.modelId);
    res.json(
      await service.updateModel(
        req.params.providerId,
        id,
        modelUpdateSchema.parse(req.body),
      ),
    );
  });
  router.delete('/providers/:providerId/models', async (req, res) => {
    const id = modelInputSchema.shape.id.parse(req.query.modelId);
    await service.deleteModel(req.params.providerId, id);
    res.sendStatus(204);
  });
  router.post('/providers/:providerId/sync', async (req, res) => {
    res.json(await service.syncModels(req.params.providerId));
  });
  return router;
}
