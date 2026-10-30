import { randomUUID } from 'node:crypto';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';

/** One identity per host user database, shared by its replicas and restarts. */
export class SignalServiceScope1793318400000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE plugin_vibe_quant_signal_service (
      id integer PRIMARY KEY CHECK (id = 1), service_id uuid NOT NULL UNIQUE
    )`);
    await runner.query(
      'INSERT INTO plugin_vibe_quant_signal_service (id, service_id) VALUES (1, $1)',
      [randomUUID()],
    );
  }

  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE plugin_vibe_quant_signal_service');
  }
}

export async function signalServiceId(database: DataSource): Promise<string> {
  const [row] = await database.query(
    'SELECT service_id FROM plugin_vibe_quant_signal_service WHERE id = 1',
  );
  if (!row?.service_id)
    throw new Error('策略监听服务标识缺失，请先完成数据库迁移');
  return row.service_id;
}
