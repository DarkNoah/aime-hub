import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import type { Auth } from '@aime/auth';
import { normalizeWebOrigins, type WebOrigins } from '@aime/shared';
import type { HttpEnv } from './http.js';
import { authRoutes } from './modules/auth/routes.js';
import { requireAdmin } from './modules/auth/require-admin.js';
import { healthRoutes } from './modules/health/routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { threadRoutes } from './modules/threads/routes.js';
import { providerRouter } from './modules/providers/rpc.js';
import { threadRouter } from './modules/threads/rpc.js';
import { projectRouter } from './modules/projects/rpc.js';
import { skillRouter } from './modules/skills/rpc.js';
import { fileRouter } from './modules/files/rpc.js';
import { rpc } from './rpc/context.js';
import type { ProviderService } from './modules/providers/service.js';
import type { ThreadService } from './modules/threads/service.js';
import type { LanguageModelService } from './modules/models/language-model.js';
import type { ProjectService } from './modules/projects/service.js';
import type { SkillService } from './modules/skills/service.js';
import type { EnvironmentVariableService } from './modules/environment-variables/service.js';
import { environmentVariableRouter } from './modules/environment-variables/rpc.js';
import { requestLogRouter } from './modules/request-logs/rpc.js';
import type { RequestLogService } from './modules/request-logs/service.js';
import type { ToolService } from './modules/tools/service.js';
import { toolRouter } from './modules/tools/rpc.js';
import { agentRouter } from './modules/agents/rpc.js';
import type { AgentService } from './modules/agents/service.js';
import type { AutomationService } from './modules/automations/service.js';
import { automationRouter } from './modules/automations/rpc.js';
import type { NotificationService } from './modules/notifications/service.js';
import { notificationRouter } from './modules/notifications/rpc.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { assetRouter } from './modules/assets/rpc.js';
import type { AssetService } from './modules/assets/service.js';
import type { McpService } from './modules/mcp/service.js';
import { mcpRouter } from './modules/mcp/rpc.js';

export function createApp(
  auth: Auth,
  providers?: { service: ProviderService; webOrigin: WebOrigins },
  chat?: {
    threads: ThreadService;
    models: LanguageModelService;
    webOrigin: WebOrigins;
    projects?: ProjectService;
    assets?: AssetService;
  },
  skills?: { service: SkillService; webOrigin: WebOrigins },
  environmentVariables?: {
    service: EnvironmentVariableService;
    webOrigin: WebOrigins;
  },
  requestLogs?: { service: RequestLogService; webOrigin: WebOrigins },
  tools?: { service: ToolService; webOrigin: WebOrigins },
  agents?: { service: AgentService; webOrigin: WebOrigins },
  automations?: { service: AutomationService; webOrigin: WebOrigins },
  notifications?: { service: NotificationService; webOrigin: WebOrigins },
  mcp?: { service: McpService; webOrigin: WebOrigins },
) {
  const app = new Hono<HttpEnv>();
  const webOrigins = normalizeWebOrigins(
    providers?.webOrigin ??
      chat?.webOrigin ??
      skills?.webOrigin ??
      environmentVariables?.webOrigin ??
      requestLogs?.webOrigin ??
      tools?.webOrigin ??
      agents?.webOrigin ??
      automations?.webOrigin ??
      notifications?.webOrigin ??
      mcp?.webOrigin ??
      [],
  );
  app.use('*', secureHeaders());
  app.route('/api', healthRoutes());
  // Better Auth owns its request bodies and its admin endpoints.
  app.route('/api', authRoutes(auth));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  const router = rpc.router({
    providers: providerRouter(providers?.service),
    threads: threadRouter(chat?.threads, chat?.models),
    projects: projectRouter(chat?.projects, chat?.threads, chat?.models),
    skills: skillRouter(skills?.service),
    files: fileRouter(chat?.threads),
    assets: assetRouter(chat?.assets, chat?.threads),
    requestLogs: requestLogRouter(requestLogs?.service),
    tools: toolRouter(tools?.service),
    agents: agentRouter(agents?.service),
    mcp: mcpRouter(mcp?.service),
    automations: automationRouter(automations?.service),
    notifications: notificationRouter(notifications?.service),
    environmentVariables: environmentVariableRouter(
      environmentVariables?.service,
    ),
  });
  if (notifications)
    app.route(
      '/api/notifications',
      notificationRoutes(auth, notifications.service),
    );
  const rpcHandler = new RPCHandler(router);
  const httpHandler = new OpenAPIHandler(router, {
    customErrorResponseBodyEncoder: (error) => ({ code: error.code }),
  });
  if (chat)
    app.route('/api/threads', threadRoutes(auth, chat.threads, webOrigins));
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    const threadRequest =
      /^\/api\/(?:threads(?:\/|$)|rpc\/(?:threads|files)\/)/.test(path);
    const projectRequest = /^\/api\/(?:projects(?:\/|$)|rpc\/projects\/)/.test(
      path,
    );
    return bodyLimit({
      maxSize: threadRequest
        ? 12 * 1024 * 1024
        : projectRequest
          ? 32 * 1024
          : 128 * 1024,
      onError: (ctx) => {
        const code = threadRequest ? 'MESSAGE_TOO_LARGE' : 'VALIDATION_ERROR';
        // Boundary errors must use the RPC envelope when the caller uses RPC.
        return ctx.json(
          ctx.req.path.startsWith('/api/rpc/')
            ? { json: new ORPCError(code, { status: 413 }).toJSON() }
            : { code },
          413,
        );
      },
    })(c, next);
  });
  app.use('/api/*', async (c, next) => {
    const isRpc = c.req.path.startsWith('/api/rpc/');
    if (isRpc && !['GET', 'POST'].includes(c.req.method))
      return c.json(
        { json: new ORPCError('METHOD_NOT_SUPPORTED').toJSON() },
        405,
      );
    const result = await (isRpc ? rpcHandler : httpHandler).handle(c.req.raw, {
      prefix: isRpc ? '/api/rpc' : '/api',
      context: {
        auth,
        headers: c.req.raw.headers,
        method: c.req.method,
        webOrigins,
      },
    });
    if (result.matched)
      return c.newResponse(result.response.body, result.response);
    await next();
  });
  app.use('/api/admin/*', requireAdmin(auth));
  app.all('/api/admin/*', (c) =>
    c.json({ message: '该管理模块尚未实现' }, 501),
  );
  app.notFound((c) => c.json({ message: '接口不存在' }, 404));
  app.onError(errorHandler);
  return app;
}
