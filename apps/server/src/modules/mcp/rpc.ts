import { rpc, required } from '../../rpc/context.js';
import type { McpService } from './service.js';

export function mcpRouter(service?: McpService) {
  const p = rpc.mcp;
  const mcp = () => required(service);
  return p.router({
    tools: p.tools.handler(({ input }) => mcp().listTools(input.params.id)),
    test: p.test.handler(({ input }) => mcp().testConnection(input.params.id)),
    list: p.list.handler(() => mcp().list()),
    get: p.get.handler(({ input }) => mcp().get(input.params.id)),
    create: p.create.handler(({ input, context }) =>
      mcp().create(context.userId, input.body),
    ),
    update: p.update.handler(({ input }) =>
      mcp().update(input.params.id, input.body),
    ),
    status: p.status.handler(({ input }) =>
      mcp().setStatus(input.params.id, input.body),
    ),
    remove: p.remove.handler(({ input }) =>
      mcp().remove(input.params.id, input.query.revision),
    ),
  });
}
