import { createDataSource } from '@aime/db';
import { loadEnv } from '@aime/shared/env';

const database = createDataSource(loadEnv().DATABASE_URL);
try {
  await database.initialize();
  const migrations = await database.runMigrations({ transaction: 'all' });
  console.log(`数据库迁移完成，本次执行 ${migrations.length} 项。`);
} finally {
  if (database.isInitialized) await database.destroy();
}
