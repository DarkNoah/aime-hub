import { Pool } from 'pg';
import { createAuthOptions } from '@aime/auth';
import { getMigrations } from '@aime/auth/migrations';
import { createDataSource } from '@aime/db';
import { loadEnv } from '@aime/shared/env';

import { pluginDatabases } from '../apps/server/src/modules/plugins/generated-database.js';
import { migratePlugins } from '../apps/server/src/modules/plugins/migrations.js';

const env = loadEnv();
const database = createDataSource(
  env.DATABASE_URL,
  pluginDatabases.flatMap((p) => p.database.entities),
);
const pool = new Pool({ connectionString: env.DATABASE_URL });
const lock = await pool.connect();
try {
  await lock.query(
    "SELECT pg_advisory_lock(hashtext('host-database-migrations'))",
  );
  const authOptions = createAuthOptions({
    pool,
    secret: env.BETTER_AUTH_SECRET,
    webOrigin: env.WEB_ORIGINS,
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
  console.log(
    `插件迁移完成，本次执行 ${await migratePlugins(database, pluginDatabases)} 项。`,
  );
} finally {
  await lock
    .query("SELECT pg_advisory_unlock(hashtext('host-database-migrations'))")
    .finally(() => lock.release());
  await Promise.all([
    pool.end(),
    database.isInitialized ? database.destroy() : Promise.resolve(),
  ]);
}
