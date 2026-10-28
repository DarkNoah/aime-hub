import { randomUUID } from 'node:crypto';
import type {
  FactorAnalysis,
  FactorAnalysisSummary,
  FactorDetail,
  FactorDraft,
  FactorSummary,
  FactorVersion,
} from '../../factor-types.js';
import { ClickHouseClient, ClickHouseError } from '../clickhouse-client.js';
import { sha256 } from '../strategies/sources.js';
import { FactorError } from './schema.js';

type RecordRow<T> = { payload: T; revision: number };

/** Shared library, like strategies. Actor IDs are attribution; execution requires admin. */
export class FactorStore extends ClickHouseClient {
  async initialize() {
    for (const name of [
      'quant_factors',
      'quant_factor_versions',
      'quant_factor_analyses',
    ]) {
      try {
        await this.request(`SELECT id FROM ${this.table(name)} LIMIT 0`);
      } catch (error) {
        if (!(error instanceof ClickHouseError) || error.code !== 60)
          throw error;
        await this.request(`CREATE TABLE IF NOT EXISTS ${this.table(name)} (
          id String, actor String, payload String CODEC(ZSTD(3)), revision UInt64
        ) ENGINE = ReplacingMergeTree(revision) ORDER BY id`);
      }
    }
  }

  private async read<T>(table: string, id: string): Promise<RecordRow<T>> {
    const [row] = await this.rows<{ payload: string; revision: number }>(
      `SELECT payload, revision FROM ${this.table(table)} FINAL WHERE id={id:String}`,
      { id },
    );
    if (!row) throw new FactorError('记录不存在', 404);
    return { payload: JSON.parse(row.payload), revision: Number(row.revision) };
  }

  private async put(
    table: string,
    actor: string,
    value: { id: string },
    previous: number,
  ) {
    const exists = `SELECT 1 FROM ${this.table(table)} FINAL WHERE id={id:String}`;
    const result = await this.execute(
      `INSERT INTO ${this.table(table)}
      SELECT {id:String}, {actor:String}, payload, {next:UInt64} FROM input('payload String')
      WHERE ${previous ? `EXISTS (${exists} AND revision={previous:UInt64})` : `NOT EXISTS (${exists})`}
      FORMAT JSONEachRow`,
      {
        id: value.id,
        actor,
        next: String(previous + 1),
        previous: String(previous),
      },
      JSON.stringify({ payload: JSON.stringify(value) }),
      `factor-state:${table}:${value.id}`,
    );
    if (result.writtenRows !== 1)
      throw new FactorError('记录已被修改，请重新加载后保存', 409);
  }

  async list(): Promise<FactorSummary[]> {
    const rows = await this.rows<
      Omit<FactorSummary, 'enabled'> & { enabled: number | boolean }
    >(
      `SELECT id, JSONExtractString(payload, 'name') AS name,
       JSONExtractString(payload, 'description') AS description,
       JSONExtractBool(payload, 'enabled') AS enabled, revision,
       JSONExtractUInt(payload, 'version_count') AS version_count,
       JSONExtractString(payload, 'updated_at') AS updated_at
       FROM ${this.table('quant_factors')} FINAL ORDER BY updated_at DESC, id`,
    );
    return rows.map((row) => ({
      ...row,
      enabled: !!row.enabled,
      revision: Number(row.revision),
    }));
  }

  async detail(id: string) {
    return (await this.read<FactorDetail>('quant_factors', id)).payload;
  }

  async save(
    actor: string,
    draft: FactorDraft,
    id: string = randomUUID(),
    revision = 0,
  ): Promise<FactorDetail> {
    const previous = revision ? await this.detail(id) : null;
    if (previous && previous.revision !== revision)
      throw new FactorError('记录已被修改，请重新加载后保存', 409);
    const next: FactorDetail = {
      ...draft,
      id,
      revision: revision + 1,
      versions: previous?.versions ?? [],
      version_count: previous?.version_count ?? 0,
      updated_at: new Date().toISOString(),
    };
    await this.put('quant_factors', actor, next, revision);
    return next;
  }

  async publish(actor: string, id: string, revision: number, note: string) {
    const row = await this.detail(id);
    if (row.revision !== revision)
      throw new FactorError('记录已被修改，请重新加载后发布', 409);
    if (!row.enabled) throw new FactorError('请先启用因子');
    const version: FactorVersion = {
      id: randomUUID(),
      factor_id: id,
      number: row.version_count + 1,
      source: row.source,
      source_hash: sha256(row.source),
      parameters: row.parameters,
      note,
      created_at: new Date().toISOString(),
    };
    await this.put('quant_factor_versions', actor, version, 0);
    const next = {
      ...row,
      revision: revision + 1,
      version_count: version.number,
      versions: [version, ...row.versions],
      updated_at: version.created_at,
    };
    await this.put('quant_factors', actor, next, revision);
    return next;
  }

  async version(id: string) {
    const row = (await this.read<FactorVersion>('quant_factor_versions', id))
      .payload;
    if (sha256(row.source) !== row.source_hash)
      throw new FactorError('因子源码校验失败');
    return row;
  }

  async saveAnalysis(actor: string, value: FactorAnalysis, revision: number) {
    await this.put('quant_factor_analyses', actor, value, revision);
  }

  async analyses(id: string): Promise<FactorAnalysisSummary[]> {
    const rows = await this.rows<
      Omit<FactorAnalysisSummary, 'config' | 'parameters'> & {
        config: string;
        parameters: string;
      }
    >(
      `SELECT id, JSONExtractString(payload, 'factor_id') AS factor_id,
       JSONExtractString(payload, 'created_at') AS created_at,
       nullIf(JSONExtractString(payload, 'finished_at'), '') AS finished_at,
       JSONExtractString(payload, 'status') AS status,
       JSONExtractString(payload, 'message') AS message,
       JSONExtractString(payload, 'source_hash') AS source_hash,
       JSONExtractRaw(payload, 'config') AS config, JSONExtractRaw(payload, 'parameters') AS parameters
       FROM ${this.table('quant_factor_analyses')} FINAL WHERE factor_id={id:String}
       ORDER BY created_at DESC, id DESC LIMIT 50`,
      { id },
    );
    return rows.map((row) =>
      this.recoverSummary({
        ...row,
        config: JSON.parse(row.config),
        parameters: JSON.parse(row.parameters),
      }),
    );
  }

  private recoverSummary<T extends FactorAnalysisSummary>(row: T): T {
    return row.status === 'running' &&
      Date.now() - Date.parse(row.created_at) > 11 * 60_000
      ? { ...row, status: 'failed', message: '分析进程已中断，请重新运行' }
      : row;
  }

  async analysis(id: string) {
    return this.recoverSummary(
      (await this.read<FactorAnalysis>('quant_factor_analyses', id)).payload,
    );
  }
}
