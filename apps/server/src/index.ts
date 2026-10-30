import { GroupChatService } from './modules/group-chats/service.js';
import { createGroupChatRuntime } from './modules/group-chats/runtime.js';
import { UserService } from './modules/users/service.js';
import { AudioService } from './modules/audio/service.js';
import { PgVector } from '@mastra/pg';
import { resolveMemoryConfig } from './mastra/memory.js';
import { KnowledgeService } from './modules/knowledge/service.js';
import { KnowledgeWorker } from './modules/knowledge/worker.js';
import { syncPluginSkills } from './modules/plugins/assets.js';
import { installedPlugins } from './modules/plugins/generated.js';
import { PluginService } from './modules/plugins/service.js';
import { requestWebResource } from './mastra/web/request.js';
import { readArticleContent } from './mastra/web/article.js';
import { registerPluginSkillAccess } from './modules/plugins/skill-access.js';
import { UsageService } from './modules/usage/service.js';
import 'reflect-metadata';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createAuth } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { createDataSource } from '@aime/db';
import { loadEnv } from '@aime/shared/env';
import { createApp } from './app.js';
import { createApiDocsPlugin } from './modules/api-docs/plugin.js';
import { ProviderService } from './modules/providers/service.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMastraRuntime } from './mastra/index.js';
import { createChatRunner } from './modules/threads/runner.js';
import { LanguageModelService } from './modules/models/language-model.js';
import { installChatRequestLogging } from './modules/models/request-logging.js';
import { RequestLogService } from './modules/request-logs/service.js';
import { ThreadService } from './modules/threads/service.js';
import { ProjectService } from './modules/projects/service.js';
import { SkillService } from './modules/skills/service.js';
import { LocalAgentService } from './modules/agents/local-service.js';
import { syncBuiltinSkills } from './modules/skills/builtin.js';
import { EnvironmentVariableService } from './modules/environment-variables/service.js';
import { projectAgentMounts } from './modules/threads/workspace.js';
import { ToolService } from './modules/tools/service.js';
import { AgentService } from './modules/agents/service.js';
import { McpService } from './modules/mcp/service.js';
import { initializeMcpAfterListen } from './modules/mcp/startup.js';
import { agentSettingsStore } from './modules/agents/settings.js';
import { createAutomationRuntime } from './modules/automations/runtime.js';
import { hasAdminRole } from '@aime/shared';
import type { ScheduleHooks } from '@mastra/core/schedules';
import type { Mastra } from '@mastra/core/mastra';
import { NotificationService } from './modules/notifications/service.js';
import { PgNotificationStore } from './modules/notifications/store.js';
import { createPushTransport } from './modules/notifications/push.js';
import { AssetService } from './modules/assets/service.js';
import { SystemSettingsService } from './modules/system-settings/service.js';
import { LocalApiAccess } from './modules/auth/local-api.js';
import { AvatarService } from './modules/profile/avatars.js';

const env = loadEnv();
const workspaceRoot = resolve(
  process.env.INIT_CWD ?? process.cwd(),
  env.WORKSPACE_ROOT,
);
await syncBuiltinSkills(
  fileURLToPath(new URL('./mastra/skills/', import.meta.url)),
  workspaceRoot,
);
const database = createDataSource(
  env.DATABASE_URL,
  installedPlugins.flatMap((p) => p.database.entities),
);
let requestLoggingEnabled: boolean;
const systemSettings = new SystemSettingsService(
  database,
  (settings) => {
    requestLoggingEnabled = settings.requestLoggingEnabled;
  },
  env.E2B_API_URL
    ? {
        apiUrl: env.E2B_API_URL,
        apiKey: env.E2B_API_KEY,
        template: env.E2B_DESKTOP_TEMPLATE,
        timeoutSeconds: env.E2B_DESKTOP_TIMEOUT_SECONDS,
      }
    : undefined,
);
const pool = new Pool({ connectionString: env.DATABASE_URL });
const auth = createAuth({
  pool,
  secret: env.BETTER_AUTH_SECRET,
  webOrigin: env.WEB_ORIGINS,
  admins: env.ADMINS,
  isRegistrationEnabled: async () =>
    (await systemSettings.get()).registrationEnabled,
});
try {
  await database.initialize();
  const authMigrations = await getMigrations(auth.options);
  if (
    authMigrations.toBeCreated.length ||
    authMigrations.toBeAdded.length ||
    authMigrations.toBeAddedIndexes.length ||
    authMigrations.schemaProblems.length ||
    (await database.showMigrations())
  ) {
    throw new Error('数据库结构未就绪，请先运行 pnpm db:migrate');
  }
  requestLoggingEnabled = (await systemSettings.get()).requestLoggingEnabled;
} catch (error) {
  await Promise.allSettled([
    pool.end(),
    database.isInitialized ? database.destroy() : Promise.resolve(),
  ]);
  throw error;
}
const notifications = new NotificationService(
  new PgNotificationStore(pool),
  createPushTransport({
    publicKey: env.WEB_PUSH_PUBLIC_KEY,
    privateKey: env.WEB_PUSH_PRIVATE_KEY,
    subject: env.WEB_PUSH_SUBJECT,
  }),
);
const plugins = new PluginService(
  database,
  installedPlugins,
  2000,
  {
    applicationRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    workspaceRoot,
  },
  {
    fetchContent: readArticleContent,
    request: requestWebResource,
  },
  (pluginId) => ({
    publish: (input) => notifications.publishPlugin(pluginId, input),
  }),
);
await syncPluginSkills(workspaceRoot);
const disposePluginSkills = registerPluginSkillAccess(
  workspaceRoot,
  async (userId) =>
    new Set(
      (userId
        ? await plugins.listForUser(userId)
        : (await plugins.list()).filter((p) => p.enabled)
      ).map((p) => p.id),
    ),
);
const providers = new ProviderService(database);
const assets = new AssetService(database);
const requestLogs = new RequestLogService(database);
const usage = new UsageService(database);
const disposeChatRequestLogging = installChatRequestLogging(
  undefined,
  (request) => requestLogs.record(request),
  (response) => requestLogs.recordResponse(response),
  () => requestLoggingEnabled,
);
const projects = new ProjectService(database, { workspaceRoot });
const groupChats = new GroupChatService(database, projects);
const users = new UserService(database, groupChats);
const environmentVariables = new EnvironmentVariableService(database);
const localApi = new LocalApiAccess(
  `http://127.0.0.1:${env.SERVER_PORT}/api`,
  async (userId) => {
    const { rows } = await pool.query(
      'SELECT banned FROM users WHERE id = $1',
      [userId],
    );
    return !!rows[0] && !rows[0].banned;
  },
);
const scheduleHooks: ScheduleHooks<Mastra> = {};
const memoryVectors = new PgVector({
  id: 'chat-memory',
  connectionString: env.DATABASE_URL,
  schemaName: 'mastra',
});
const getMemoryConfig = () => resolveMemoryConfig(providers, memoryVectors);
const { mastra, storage, memory } = createMastraRuntime(
  pool,
  'mastra',
  scheduleHooks,
  await getMemoryConfig(),
);
await storage.init();
const skills = new SkillService(workspaceRoot);
const agentStore = await storage.getStore('agents');
if (!agentStore) throw new Error('Mastra agents storage is required');
const mcpStore = await storage.getStore('mcpClients');
if (!mcpStore) throw new Error('Mastra MCP clients storage is required');
const mcp = new McpService(mcpStore);
const knowledgeVectors = new PgVector({
  id: 'knowledge',
  connectionString: env.DATABASE_URL,
});
const knowledge = new KnowledgeService(
  database,
  knowledgeVectors,
  providers,
  projects,
);
const knowledgeWorker = new KnowledgeWorker(knowledge);
knowledgeWorker.start();
const audio = new AudioService(workspaceRoot, providers, async () => {
  const config = await tools.get('transcriptions');
  if (config.kind !== 'transcriptions')
    throw new Error('Invalid transcription configuration');
  return config.config;
});
const tools: ToolService = new ToolService(
  database,
  providers,
  assets,
  mcp,
  plugins,
  knowledge,
  () => automations.service,
  audio,
);
const localAgents = new LocalAgentService(workspaceRoot, projects);
const agents = new AgentService(
  agentStore,
  skills,
  tools,
  providers,
  agentSettingsStore(database),
  plugins,
  localAgents,
);
const models = new LanguageModelService(database, providers, agents);
const threads = new ThreadService(
  memory,
  createChatRunner(
    mastra,
    models,
    workspaceRoot,
    projects,
    tools,
    agents,
    usage,
    environmentVariables,
    getMemoryConfig,
    localApi,
    plugins,
    groupChats,
  ),
  projects,
  mastra.backgroundTaskManager,
  async (id) => {
    const { rows } = await pool.query(
      'SELECT role, banned FROM users WHERE id = $1',
      [id],
    );
    return !!rows[0] && !rows[0].banned && hasAdminRole(rows[0].role);
  },
);
const groupChatRuntime = createGroupChatRuntime(
  groupChats,
  threads,
  async (userId) => {
    const { rows } = await pool.query(
      'SELECT banned FROM users WHERE id = $1',
      [userId],
    );
    return !!rows[0] && !rows[0].banned;
  },
);
const automations = createAutomationRuntime({
  notifications,
  mastra,
  pool,
  scheduleHooks,
  threads,
  agents,
  models,
  projects,
  tools,
  workspaceRoot,
  environmentVariables,
  getMemoryConfig,
});
const app = createApp(
  auth,
  {
    service: providers,
    webOrigin: env.WEB_ORIGINS,
  },
  {
    threads,
    models,
    projects,
    assets,
    localApi,
    groupChats,
    users,
    webOrigin: env.WEB_ORIGINS,
  },
  { service: skills, webOrigin: env.WEB_ORIGINS },
  {
    service: environmentVariables,
    webOrigin: env.WEB_ORIGINS,
  },
  { service: requestLogs, webOrigin: env.WEB_ORIGINS },
  { service: tools, webOrigin: env.WEB_ORIGINS },
  {
    service: agents,
    local: localAgents,
    webOrigin: env.WEB_ORIGINS,
  },
  { service: automations.service, webOrigin: env.WEB_ORIGINS },
  { service: notifications, webOrigin: env.WEB_ORIGINS },
  { service: mcp, webOrigin: env.WEB_ORIGINS },
  { service: systemSettings, webOrigin: env.WEB_ORIGINS },
  { service: usage, webOrigin: env.WEB_ORIGINS },
  plugins,
  knowledge,
  await createApiDocsPlugin(env.NODE_ENV),
  audio,
  { service: new AvatarService(workspaceRoot), webOrigin: env.WEB_ORIGINS },
);

async function disposeResources() {
  // Wait for every cleanup before closing the shared database, even on failure.
  const results = await Promise.allSettled([
    plugins.dispose().finally(disposePluginSkills),
    mastra.shutdown(),
    knowledgeVectors.disconnect(),
    memory.settled().then(() => memoryVectors.disconnect()),
    mcp.shutdown(),
    skills.dispose(),
    projectAgentMounts.dispose(),
  ]);
  for (const cleanup of [
    () => disposeChatRequestLogging(),
    () => requestLogs.settled(),
    () => database.destroy(),
    () => pool.end(),
  ]) {
    results.push(
      ...(await Promise.allSettled([Promise.resolve().then(cleanup)])),
    );
  }
  const errors = results.filter((result) => result.status === 'rejected');
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      'Server cleanup failed',
    );
}

let server: Server | undefined;
let shutdownTask: Promise<void> | undefined;
let stopping = false;
function shutdown() {
  if (shutdownTask) return shutdownTask;
  stopping = true;
  plugins.beginShutdown();
  server?.closeIdleConnections();
  return (shutdownTask = (async () => {
    // Signals during restoration must wait for the callback before releasing resources.
    await startup.catch(() => {});
    for (const cleanup of [
      () => groupChatRuntime.shutdown(),
      () => automations.shutdown(),
      () => knowledgeWorker.stop(),
      () => threads.shutdown(),
      () => notifications.close(),
      async () => {
        if (!server) return;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      },
      () => disposeResources(),
    ]) {
      await Promise.resolve()
        .then(cleanup)
        .catch(() => {
          console.error('Server shutdown cleanup failed');
          process.exitCode = 1;
        });
    }
  })());
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
const startup = (async () => {
  await plugins.start();
  if (stopping) return;
  await automations.initialize();
  if (stopping) return;
  // Restore plugin resources before schedules can execute plugin tools.
  await mastra.startWorkers();
  if (stopping) return;
  groupChatRuntime.start();
  server = serve(
    { fetch: app.fetch, port: env.SERVER_PORT, hostname: env.SERVER_HOST },
    () =>
      console.log(`Aime Hub API: http://${env.SERVER_HOST}:${env.SERVER_PORT}`),
  ) as Server;
  initializeMcpAfterListen(server, mcp);
  server.once('error', (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === 'EADDRINUSE'
        ? `API startup failed: ${env.SERVER_HOST}:${env.SERVER_PORT} is already in use`
        : 'API server failed to listen',
    );
    process.exitCode = 1;
    void shutdown();
  });
})();
try {
  await startup;
} catch (error) {
  await shutdown();
  throw error;
}
