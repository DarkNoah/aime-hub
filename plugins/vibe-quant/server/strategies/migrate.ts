import type { DataSource } from 'typeorm';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sha256 } from './sources.js';
import { StrategyStore, type StoredRun, type StoredStrategy } from './store.js';

const decompress = promisify(gunzip);
const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Old tables are recovery backups only. Run before exposing routes or starting workers. */
export async function migrateStrategies(db: DataSource, store: StrategyStore) {
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction('REPEATABLE READ');
  try {
    await runner.query('SET TRANSACTION READ ONLY');
    const [tables] = await runner.query(`SELECT
      to_regclass('plugin_vibe_quant_strategies') IS NOT NULL AS strategies`);
    if (!tables.strategies) return;
    const [fingerprint] =
      await runner.query(`SELECT current_database() AS database, current_schema() AS schema,
      (SELECT md5(coalesce(string_agg(id::text || ':' || revision::text, ',' ORDER BY id), '')) FROM plugin_vibe_quant_strategies) AS strategies,
      (SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(heartbeat_at::text, ''), ',' ORDER BY id), '')) FROM plugin_vibe_quant_runs) AS runs,
      (SELECT md5(coalesce(string_agg(run_id::text || ':' || kind || ':' || hash, ',' ORDER BY run_id, kind), '')) FROM plugin_vibe_quant_run_artifacts) AS artifacts`);
    const migrationId = sha256(JSON.stringify({ version: 1, ...fingerprint }));
    const done = await store.rows(
      `SELECT 1 FROM ${store.table('quant_strategy_migrations')} FINAL WHERE id = {id:String}`,
      { id: migrationId },
    );
    if (done.length) return;
    await store.sources.migrateLegacy(runner);
    let cursor = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const strategies = await runner.query(
        'SELECT * FROM plugin_vibe_quant_strategies WHERE id > $1 ORDER BY id LIMIT 100',
        [cursor],
      );
      if (!strategies.length) break;
      for (const strategy of strategies) {
        const versions = await runner.query(
          'SELECT * FROM plugin_vibe_quant_versions WHERE strategy_id=$1 ORDER BY number',
          [strategy.id],
        );
        await store.importStrategy(
          normalize({ ...strategy, versions } as StoredStrategy),
        );
      }
      cursor = strategies.at(-1).id;
    }
    cursor = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const runs: StoredRun[] = await runner.query(
        `SELECT r.*, s.user_id, v.number AS version_number, v.source_hash FROM plugin_vibe_quant_runs r
         JOIN plugin_vibe_quant_strategies s ON s.id=r.strategy_id JOIN plugin_vibe_quant_versions v ON v.id=r.version_id
         WHERE r.id > $1 ORDER BY r.id LIMIT 20`,
        [cursor],
      );
      if (!runs.length) break;
      for (const original of runs) {
        const artifacts: { kind: string; hash: string; data: Buffer }[] =
          await runner.query(
            'SELECT kind, hash, data FROM plugin_vibe_quant_run_artifacts WHERE run_id=$1 ORDER BY kind',
            [original.id],
          );
        for (const artifact of artifacts) {
          const text = (
            await decompress(artifact.data, {
              maxOutputLength: 64 * 1024 * 1024,
            })
          ).toString('utf8');
          if (sha256(text) !== artifact.hash)
            throw new Error('旧回测产物哈希校验失败');
          await store.putArtifact(original.id, artifact.kind, text);
        }
        const run = normalize(original);
        if (['preparing', 'running'].includes(run.status)) {
          run.status = 'failed';
          run.message = '存储迁移中断了旧执行进程，请重新创建回测';
          run.finished_at = new Date().toISOString();
        }
        await store.importRun(run);
      }
      cursor = runs.at(-1)!.id;
    }
    await store.execute(
      `INSERT INTO ${store.table('quant_strategy_migrations')} SELECT {id:String}
       WHERE NOT EXISTS (SELECT 1 FROM ${store.table('quant_strategy_migrations')} FINAL WHERE id = {id:String})`,
      { id: migrationId },
      undefined,
      'strategy-state',
    );
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}
