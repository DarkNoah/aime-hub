import { rpc, required } from '../../rpc/context.js';
import type { ProjectService } from '../projects/service.js';
import { EnvironmentVariableService } from './service.js';

export function projectEnvironmentVariableRouter(projects?: ProjectService) {
  const p = rpc.projectEnvironmentVariables;
  // Serialize access with project role changes and deletion. The same transaction
  // checks permissions and accesses the scoped variable, including secret reads.
  const access = <T>(
    userId: string,
    projectId: string,
    action: (variables: EnvironmentVariableService) => Promise<T>,
  ) =>
    required(projects).withManagementAccess(userId, projectId, (manager) =>
      action(new EnvironmentVariableService(manager)),
    );
  return p.router({
    list: p.list.handler(({ context, input: { params } }) =>
      access(context.userId, params.projectId, (variables) =>
        variables.list(params),
      ),
    ),
    get: p.get.handler(({ context, input: { params } }) =>
      access(context.userId, params.projectId, (variables) =>
        variables.get(params.id, { projectId: params.projectId }),
      ),
    ),
    create: p.create.handler(({ context, input: { params, body } }) =>
      access(context.userId, params.projectId, (variables) =>
        variables.create(body, params),
      ),
    ),
    update: p.update.handler(({ context, input: { params, body } }) =>
      access(context.userId, params.projectId, (variables) =>
        variables.update(params.id, body, { projectId: params.projectId }),
      ),
    ),
    remove: p.remove.handler(({ context, input: { params } }) =>
      access(context.userId, params.projectId, (variables) =>
        variables.remove(params.id, { projectId: params.projectId }),
      ),
    ),
  });
}
