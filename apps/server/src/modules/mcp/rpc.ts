import { rpc, required } from '../../rpc/context.js';
import type { McpService } from './service.js';
import { McpError } from './errors.js';

export function mcpRouter(service?: McpService) {
  const p = rpc.mcp;
  const mcp = () => required(service);
  return p.router({
    authorize: p.authorize.handler(({ input, context }) =>
      mcp().startOAuth(
        input.params.id,
        context.userId,
        context.headers.get('origin') ?? '',
        input.body.revision,
      ),
    ),
    disconnectOAuth: p.disconnectOAuth.handler(({ input, context }) =>
      mcp().disconnectOAuth(
        input.params.id,
        input.body.revision,
        context.userId,
      ),
    ),
    load: p.load.handler(({ input, context }) =>
      mcp().load(input.params.id, context.userId),
    ),
    tools: p.tools.handler(({ input, context }) =>
      mcp().listTools(input.params.id, context.userId),
    ),
    test: p.test.handler(({ input, context }) =>
      mcp().testConnection(input.params.id, context.userId),
    ),
    list: p.list.handler(({ context }) => mcp().list(context.userId)),
    get: p.get.handler(({ input, context }) =>
      mcp().get(input.params.id, context.userId),
    ),
    create: p.create.handler(({ input, context }) =>
      mcp().create(context.userId, input.body),
    ),
    update: p.update.handler(({ input, context }) =>
      mcp().update(input.params.id, input.body, context.userId),
    ),
    status: p.status.handler(({ input, context }) =>
      mcp().setStatus(input.params.id, input.body, context.userId),
    ),
    remove: p.remove.handler(({ input }) =>
      mcp().remove(input.params.id, input.query.revision),
    ),
  });
}

export function mcpAuthRouter(service?: McpService) {
  const p = rpc.mcpAuth;
  return p.router({
    list: p.list.handler(({ context }) =>
      required(service).authorizations(context.userId),
    ),
    get: p.get.handler(async ({ input, context }) => {
      const [server] = await required(service).authorizations(
        context.userId,
        input.params.id,
      );
      if (!server) throw new McpError('MCP_OAUTH_NOT_ENABLED');
      return server;
    }),
    authorize: p.authorize.handler(({ input, context }) =>
      required(service).startUserOAuth(
        input.params.id,
        context.userId,
        context.headers.get('origin') ?? '',
        input.body.returnTo,
      ),
    ),
  });
}
