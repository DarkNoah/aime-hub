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
import { syncBuiltinSkills } from './modules/skills/builtin.js';
import { EnvironmentVariableService } from './modules/environment-variables/service.js';
import { projectAgentMounts } from './modules/threads/workspace.js';
import { ToolService } from './modules/tools/service.js';
import { AgentService } from './modules/agents/service.js';
import { McpService } from './modules/mcp/service.js';
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

const env = loadEnv();
const workspaceRoot = resolve(
  process.env.INIT_CWD ?? process.cwd(),
  env.WORKSPACE_ROOT,
);
await syncBuiltinSkills(
  fileURLToPath(new URL('./mastra/skills/', import.meta.url)),
  workspaceRoot,
);
const database = createDataSource(env.DATABASE_URL);
const systemSettings = new SystemSettingsService(database);
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
} catch (error) {
  await Promise.allSettled([
    pool.end(),
    database.isInitialized ? database.destroy() : Promise.resolve(),
  ]);
  throw error;
}
const providers = new ProviderService(database);
const assets = new AssetService(database);
const requestLogs = new RequestLogService(database);
const usage = new UsageService(database);
const disposeChatRequestLogging = installChatRequestLogging(
  undefined,
  (request) => requestLogs.record(request),
  (response) => requestLogs.recordResponse(response),
);
const projects = new ProjectService(database, { workspaceRoot });
const notifications = new NotificationService(
  new PgNotificationStore(pool),
  createPushTransport({
    publicKey: env.WEB_PUSH_PUBLIC_KEY,
    privateKey: env.WEB_PUSH_PRIVATE_KEY,
    subject: env.WEB_PUSH_SUBJECT,
  }),
);
const scheduleHooks: ScheduleHooks<Mastra> = {};
const { mastra, storage, memory } = createMastraRuntime(
  pool,
  'mastra',
  scheduleHooks,
);
await storage.init();
const skills = new SkillService(workspaceRoot);
const agentStore = await storage.getStore('agents');
if (!agentStore) throw new Error('Mastra agents storage is required');
const mcpStore = await storage.getStore('mcpClients');
if (!mcpStore) throw new Error('Mastra MCP clients storage is required');
const mcp = new McpService(mcpStore);
await mcp.initialize();
const tools = new ToolService(database, providers, assets, mcp);
const agents = new AgentService(
  agentStore,
  skills,
  tools,
  providers,
  agentSettingsStore(database),
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
});
await automations.initialize();
// Restore persisted schedules on every boot, even before the first API request.
await mastra.startWorkers();
const app = createApp(
  auth,
  {
    service: providers,
    webOrigin: env.WEB_ORIGINS,
  },
  { threads, models, projects, assets, webOrigin: env.WEB_ORIGINS },
  { service: skills, webOrigin: env.WEB_ORIGINS },
  {
    service: new EnvironmentVariableService(database),
    webOrigin: env.WEB_ORIGINS,
  },
  { service: requestLogs, webOrigin: env.WEB_ORIGINS },
  { service: tools, webOrigin: env.WEB_ORIGINS },
  { service: agents, webOrigin: env.WEB_ORIGINS },
  { service: automations.service, webOrigin: env.WEB_ORIGINS },
  { service: notifications, webOrigin: env.WEB_ORIGINS },
  { service: mcp, webOrigin: env.WEB_ORIGINS },
  { service: systemSettings, webOrigin: env.WEB_ORIGINS },
  { service: usage, webOrigin: env.WEB_ORIGINS },
);
const server = serve(
  { fetch: app.fetch, port: env.SERVER_PORT, hostname: env.SERVER_HOST },
  () => {
    console.log(`Aime Hub API: http://${env.SERVER_HOST}:${env.SERVER_PORT}`);
  },
) as Server;
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  void automations
    .shutdown()
    .finally(() => threads.shutdown())
    .finally(() => notifications.close())
    .finally(() => {
      server.closeAllConnections();
      server.close(() => {
        void Promise.all([
          mastra.shutdown(),
          mcp.shutdown(),
          skills.dispose(),
          projectAgentMounts.dispose(),
        ])
          .finally(async () => {
            await disposeChatRequestLogging();
            await requestLogs.settled();
            await database.destroy();
          })
          .finally(() => pool.end())
          .catch(() => {
            process.exitCode = 1;
          });
      });
    });
  server.closeIdleConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
