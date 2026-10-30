import { rpc, required } from '../../rpc/context.js';
import type { EnvironmentVariableService } from './service.js';

export function environmentVariableRouter(
  service?: EnvironmentVariableService,
) {
  const p = rpc.environmentVariables;
  const variables = () => required(service);
  return p.router({
    list: p.list.handler(() => variables().list()),
    get: p.get.handler(({ input }) => variables().get(input.params.id)),
    create: p.create.handler(({ input }) => variables().create(input.body)),
    update: p.update.handler(({ input }) =>
      variables().update(input.params.id, input.body),
    ),
    remove: p.remove.handler(({ input }) =>
      variables().remove(input.params.id),
    ),
  });
}

export function personalEnvironmentVariableRouter(
  service?: EnvironmentVariableService,
) {
  const p = rpc.personalEnvironmentVariables;
  const variables = () => required(service);
  return p.router({
    list: p.list.handler(({ context }) => variables().list(context.userId)),
    get: p.get.handler(({ input, context }) =>
      variables().get(input.params.id, context.userId),
    ),
    create: p.create.handler(({ input, context }) =>
      variables().create(input.body, context.userId),
    ),
    update: p.update.handler(({ input, context }) =>
      variables().update(input.params.id, input.body, context.userId),
    ),
    remove: p.remove.handler(({ input, context }) =>
      variables().remove(input.params.id, context.userId),
    ),
  });
}
