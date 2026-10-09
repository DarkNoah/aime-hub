import { providerSummary, providerDetail, providerModel } from './dto.js';
import { rpc, required } from '../../rpc/context.js';
import type { ProviderService } from './service.js';

export function providerRouter(service?: ProviderService) {
  const p = rpc.providers;
  const providers = () => required(service);
  return p.router({
    available: p.available.handler(() => providers().listAvailableModels()),
    list: p.list.handler(() =>
      providers()
        .listProviders()
        .then((items) => items.map(providerSummary)),
    ),
    get: p.get.handler(({ input }) =>
      providers()
        .getPublicProvider(input.params.providerId)
        .then(providerDetail),
    ),
    create: p.create.handler(({ input }) =>
      providers().createProvider(input.body).then(providerSummary),
    ),
    update: p.update.handler(({ input }) =>
      providers()
        .updateProvider(input.params.providerId, input.body)
        .then(providerSummary),
    ),
    remove: p.remove.handler(({ input }) =>
      providers().deleteProvider(input.params.providerId),
    ),
    models: p.models.handler(
      async ({ input }) =>
        (
          await providers()
            .getPublicProvider(input.params.providerId)
            .then(providerDetail)
        ).models,
    ),
    createModel: p.createModel.handler(({ input }) =>
      providers()
        .createModel(input.params.providerId, input.body)
        .then(providerModel),
    ),
    updateModel: p.updateModel.handler(({ input }) =>
      providers()
        .updateModel(input.params.providerId, input.query.modelId, input.body)
        .then(providerModel),
    ),
    removeModel: p.removeModel.handler(({ input }) =>
      providers().deleteModel(input.params.providerId, input.query.modelId),
    ),
    sync: p.sync.handler(({ input }) =>
      providers().syncModels(input.params.providerId),
    ),
    defaults: p.defaults.handler(() => providers().getDefaults()),
    saveDefaults: p.saveDefaults.handler(({ input }) =>
      providers().setDefaults(input.body),
    ),
  });
}
