import { rpc, required } from '../../rpc/context.js';
import type { AgentService } from './service.js';

export function agentRouter(service?: AgentService) {
  const p = rpc.agents;
  const agents = () => required(service);
  return p.router({
    available: p.available.handler(({ context, input }) =>
      agents().available(
        { userId: context.userId, projectId: input?.query?.projectId },
        input?.query?.includeLocal !== false,
      ),
    ),
    defaults: p.defaults.handler(() => agents().getDefaults()),
    saveDefaults: p.saveDefaults.handler(({ input }) =>
      agents().setDefaults(input.body),
    ),
    list: p.list.handler(() => agents().list()),
    catalog: p.catalog.handler(() => agents().catalog()),
    get: p.get.handler(({ input }) => agents().get(input.params.id)),
    create: p.create.handler(({ input, context }) =>
      agents().create(context.userId, input.body),
    ),
    update: p.update.handler(({ input }) =>
      agents().update(input.params.id, input.body),
    ),
    setStatus: p.setStatus.handler(({ input }) =>
      agents().setStatus(input.params.id, input.body),
    ),
    remove: p.remove.handler(({ input }) =>
      agents().remove(input.params.id, input.query.versionId),
    ),
  });
}
