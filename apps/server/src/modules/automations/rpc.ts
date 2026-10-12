import { rpc, required } from '../../rpc/context.js';
import type { AutomationService } from './service.js';

export function automationRouter(service?: AutomationService) {
  const p = rpc.automations;
  const tasks = () => required(service);
  return p.router({
    list: p.list.handler(({ context, input }) =>
      tasks().list(context.userId, input),
    ),
    create: p.create.handler(({ context, input }) =>
      tasks().create(context.userId, input.scope, input.data),
    ),
    update: p.update.handler(({ context, input }) =>
      tasks().update(context.userId, input.id, input.data),
    ),
    setEnabled: p.setEnabled.handler(({ context, input }) =>
      tasks().setEnabled(context.userId, input.id, input.enabled),
    ),
    remove: p.remove.handler(({ context, input }) =>
      tasks().remove(context.userId, input.id),
    ),
    run: p.run.handler(({ context, input }) =>
      tasks().run(context.userId, input.id),
    ),
    history: p.history.handler(({ context, input }) =>
      tasks().history(context.userId, input.id),
    ),
  });
}
