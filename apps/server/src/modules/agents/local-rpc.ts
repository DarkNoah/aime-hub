import { rpc, required } from '../../rpc/context.js';
import type { LocalAgentService } from './local-service.js';

export function localAgentRouter(service?: LocalAgentService) {
  const p = rpc.localAgents;
  return p.router({
    list: p.list.handler(({ context, input }) =>
      required(service).list(context, input.query),
    ),
    create: p.create.handler(({ context, input }) =>
      required(service).create(context, input.body.target, input.body),
    ),
    update: p.update.handler(({ context, input }) =>
      required(service).update(context, input.body.target, input.body),
    ),
    remove: p.remove.handler(({ context, input }) =>
      required(service).remove(context, input.body.target, input.body),
    ),
    setEnabled: p.setEnabled.handler(({ context, input }) =>
      required(service).setEnabled(context, input.body.target, input.body),
    ),
  });
}
