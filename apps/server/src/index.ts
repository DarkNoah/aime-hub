import 'reflect-metadata';
import { Pool } from 'pg';
import { createAuth } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { createDataSource } from '@aime/db';
import { loadEnv } from '@aime/shared/env';
import { createApp } from './app.js';
import { ProviderService } from './modules/providers/service.js';
import { resolve } from 'node:path';
import { createMastraRuntime } from './mastra/index.js';
import { createChatRunner } from './modules/threads/runner.js';
import { LanguageModelService } from './modules/models/language-model.js';
import { ThreadService } from './modules/threads/service.js';
import { ProjectService } from './modules/projects/service.js';

const env = loadEnv();
const database = createDataSource(env.DATABASE_URL);
const pool = new Pool({ connectionString: env.DATABASE_URL });
const auth = createAuth({
  pool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  webOrigin: env.WEB_ORIGIN,
  admins: env.ADMINS,
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
const models = new LanguageModelService(database, providers);
const projects = new ProjectService(database);
const { mastra, storage, memory } = createMastraRuntime(pool);
await storage.init();
const workspaceRoot = resolve(
  process.env.INIT_CWD ?? process.cwd(),
  env.WORKSPACE_ROOT,
);
const threads = new ThreadService(
  memory,
  createChatRunner(mastra, models, workspaceRoot),
  projects,
);
const server = createApp(
  auth,
  {
    service: providers,
    webOrigin: env.WEB_ORIGIN,
  },
  { threads, models, projects, webOrigin: env.WEB_ORIGIN },
).listen(env.SERVER_PORT, '127.0.0.1', () => {
  console.log(`Aime Hub API: http://127.0.0.1:${env.SERVER_PORT}`);
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  void threads.shutdown().finally(() => {
    server.closeAllConnections();
    server.close(() => {
      void Promise.all([mastra.shutdown(), database.destroy()])
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
