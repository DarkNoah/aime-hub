import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ClickHouseClient, ClickHouseError } from '../clickhouse-client.js';

export const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

type Source = { hash: string; source: string };

/** Immutable, content-addressed scripts. Ownership is checked by StrategyStore. */
export class StrategySources extends ClickHouseClient {
  async initialize() {
    try {
      await this.request(
        `SELECT hash, source FROM ${this.table('quant_strategy_sources')} LIMIT 0`,
      );
    } catch (error) {
      if (!(error instanceof ClickHouseError) || error.code !== 60) throw error;
      await this
        .request(`CREATE TABLE IF NOT EXISTS ${this.table('quant_strategy_sources')} (
        hash String, source String CODEC(ZSTD(3)), createdAt DateTime64(3) DEFAULT now64(3)
      ) ENGINE = ReplacingMergeTree ORDER BY hash`);
    }
  }

  async readMany(hashes: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const unique = [...new Set(hashes)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const rows = await this.rows<Source>(
        `SELECT hash, source FROM ${this.table('quant_strategy_sources')} FINAL
         WHERE hash IN (SELECT arrayJoin(JSONExtract({hashes:String}, 'Array(String)')))`,
        { hashes: JSON.stringify(unique.slice(offset, offset + 100)) },
      );
      for (const row of rows) {
        if (sha256(row.source) !== row.hash)
          throw new Error('策略脚本哈希校验失败');
        result.set(row.hash, row.source);
      }
    }
    return result;
  }

  async read(hash: string): Promise<string> {
    const source = (await this.readMany([hash])).get(hash);
    if (source === undefined) throw new Error('策略脚本不存在于 ClickHouse');
    return source;
  }

  private async insert(rows: Source[]) {
    if (!rows.length) return;
    await this.request(
      `INSERT INTO ${this.table('quant_strategy_sources')} (hash, source)
       SETTINGS async_insert = 0 FORMAT JSONEachRow`,
      {},
      rows.map((row) => JSON.stringify(row)).join('\n'),
    );
  }

  async put(source: string): Promise<string> {
    const hash = sha256(source);
    if (!(await this.readMany([hash])).has(hash)) {
      await this.insert([{ hash, source }]);
      // Never commit a strategy reference until the script is readable and verified.
      await this.read(hash);
    }
    return hash;
  }

  /** Retry-safe backfill; retain PostgreSQL originals as a recovery backup. */
  async migrateLegacy(db: Pick<DataSource, 'query'>) {
    const [table] = await db.query(
      "SELECT to_regclass('plugin_vibe_quant_sources') IS NOT NULL AS present",
    );
    if (!table.present) return;
    let cursor = '';
    for (;;) {
      const rows: Source[] = await db.query(
        'SELECT hash, source FROM plugin_vibe_quant_sources WHERE hash > $1 ORDER BY hash LIMIT 100',
        [cursor],
      );
      if (!rows.length) return;
      for (const row of rows) {
        if (sha256(row.source) !== row.hash)
          throw new Error('旧策略脚本哈希校验失败');
      }
      const existing = await this.readMany(rows.map((row) => row.hash));
      const missing = rows.filter((row) => !existing.has(row.hash));
      await this.insert(missing);
      const copied = await this.readMany(missing.map((row) => row.hash));
      if (missing.some((row) => copied.get(row.hash) !== row.source))
        throw new Error('策略脚本迁移校验失败');
      cursor = rows.at(-1)!.hash;
    }
  }
}
