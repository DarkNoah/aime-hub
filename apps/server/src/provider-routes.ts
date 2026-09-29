import { Router, json } from 'express';
import { ZodError } from 'zod';
import {
  providerInputSchema,
  providerUpdateSchema,
  modelInputSchema,
  modelUpdateSchema,
  modelDefaultsSchema,
} from '@aime/shared/providers';
import { ProviderService } from './provider-service.js';
import { ProviderError } from './provider-network.js';

export function providerRoutes(service: ProviderService, webOrigin: string) {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.get('origin') !== new URL(webOrigin).origin
    )
      return res.status(403).json({ code: 'FORBIDDEN' });
    next();
  });
  router.use(json({ limit: '128kb' }));
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
  router.get('/settings/models', async (_req, res) => {
    res.json(await service.getDefaults());
  });
  router.put('/settings/models', async (req, res) => {
    res.json(await service.setDefaults(modelDefaultsSchema.parse(req.body)));
  });
  router.use(((error, _req, res, next) => {
    if (error instanceof ProviderError)
      return res.status(error.status).json({ code: error.code });
    if (
      error instanceof ZodError ||
      (error instanceof SyntaxError && 'body' in error)
    )
      return res.status(400).json({ code: 'VALIDATION_ERROR' });
    if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      error.type === 'entity.too.large'
    )
      return res.status(413).json({ code: 'VALIDATION_ERROR' });
    next(error);
  }) satisfies import('express').ErrorRequestHandler);
  return router;
}
