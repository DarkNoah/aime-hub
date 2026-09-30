import { Pool } from 'pg';
import { createAuthOptions } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { createDataSource } from '@aime/db';
import { loadEnv } from '@aime/shared/env';

const env = loadEnv();
const database = createDataSource(env.DATABASE_URL);
const pool = new Pool({ connectionString: env.DATABASE_URL });
try {
  const authOptions = createAuthOptions({
    pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    webOrigin: env.WEB_ORIGIN,
    admins: env.ADMINS,
  });
  const authMigrations = await getMigrations(authOptions);
  if (authMigrations.schemaProblems.length) {
    throw new Error(authMigrations.schemaProblems.join('\n'));
  }
  await authMigrations.runMigrations();
  console.log('Better Auth 认证表初始化／迁移完成。');
  await database.initialize();
  const migrations = await database.runMigrations({ transaction: 'all' });
  console.log(`业务数据库迁移完成，本次执行 ${migrations.length} 项。`);
} finally {
  await Promise.all([
    pool.end(),
    database.isInitialized ? database.destroy() : Promise.resolve(),
  ]);
}
