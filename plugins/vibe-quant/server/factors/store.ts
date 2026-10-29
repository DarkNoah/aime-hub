import { randomUUID } from 'node:crypto';
import type {
  FactorAnalysis,
  FactorAnalysisSummary,
  FactorDetail,
  FactorDraft,
  FactorSummary,
  FactorVersion,
  FactorGroups,
  FactorGroup,
} from '../../factor-types.js';
import {
  FACTOR_GROUPS,
  UNGROUPED,
  groupDescendants,
} from '../../factor-groups.js';
import { ClickHouseClient, ClickHouseError } from '../clickhouse-client.js';
import { sha256 } from '../strategies/sources.js';
import { FactorError } from './schema.js';
import {
  builtinDetail,
  builtinSummaries,
  builtinVersion,
  builtinVersions,
} from './builtins.js';

type RecordRow<T> = { payload: T; revision: number };

/** Shared library, like strategies. Actor IDs are attribution; execution requires admin. */
export class FactorStore extends ClickHouseClient {
  async initialize() {
    for (const name of [
      'quant_factors',
      'quant_factor_versions',
      'quant_factor_analyses',
      'quant_factor_groups',
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
    // Retain every shipped version even if a future catalog revises a formula.
    // One idempotent statement, serialized across app instances on this database.
    await this.execute(
      `INSERT INTO ${this.table('quant_factor_versions')}
       SELECT id, 'builtin', payload, toUInt64(1) FROM input('id String, payload String')
       WHERE id NOT IN (SELECT id FROM ${this.table('quant_factor_versions')} FINAL)
       FORMAT JSONEachRow`,
      {},
      builtinVersions()
        .map((version) =>
          JSON.stringify({ id: version.id, payload: JSON.stringify(version) }),
        )
        .join('\n'),
      'factor-builtin-version-catalog',
    );
  }

  private async read<T>(table: string, id: string): Promise<RecordRow<T>> {
    const [row] = await this.rows<{ payload: string; revision: number }>(
      `SELECT payload, revision FROM ${this.table(table)} FINAL WHERE id={id:String}`,
      { id },
    );
    if (!row) throw new FactorError('记录不存在', 404);
    return { payload: JSON.parse(row.payload), revision: Number(row.revision) };
  }

  private async put<T extends { id: string }>(
    table: string,
    actor: string,
    value: T,
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
       ,JSONExtractString(payload, 'group_id') AS group_id
       FROM ${this.table('quant_factors')} FINAL ORDER BY updated_at DESC, id`,
    );
    const { groups } = await this.groups();
    return [
      ...rows.map((row) => ({
        ...row,
        enabled: !!row.enabled,
        revision: Number(row.revision),
        group_id: groups.some((g) => g.id === row.group_id)
          ? row.group_id
          : UNGROUPED,
      })),
      ...builtinSummaries(),
    ];
  }

  async detail(id: string) {
    const builtin = builtinDetail(id);
    if (builtin) return structuredClone(builtin);
    const row = (await this.read<FactorDetail>('quant_factors', id)).payload;
    const { groups } = await this.groups();
    return {
      ...row,
      group_id: groups.some((g) => g.id === row.group_id)
        ? row.group_id
        : UNGROUPED,
    };
  }

  async groups(): Promise<FactorGroups> {
    try {
      const row = await this.read<{ groups: FactorGroup[] }>(
        'quant_factor_groups',
        'tree',
      );
      return {
        revision: row.revision,
        groups: [...FACTOR_GROUPS, ...row.payload.groups],
      };
    } catch (error) {
      if (error instanceof FactorError && error.status === 404)
        return { revision: 0, groups: [...FACTOR_GROUPS] };
      throw error;
    }
  }

  async saveGroup(
    actor: string,
    input: { name: string; parent_id: string | null; revision: number },
    id: string = randomUUID(),
  ) {
    const tree = await this.groups();
    if (tree.revision !== input.revision)
      throw new FactorError('分组已被修改，请重新加载', 409);
    const existing = tree.groups.find((g) => g.id === id);
    if (existing?.builtin)
      throw new FactorError('固定分组不能重命名或移动', 403);
    const name = input.name.trim();
    if (!name || name.length > 100)
      throw new FactorError('分组名称须为 1 至 100 个字符');
    if (input.parent_id && !tree.groups.some((g) => g.id === input.parent_id))
      throw new FactorError('上级分组不存在');
    if (
      input.parent_id &&
      groupDescendants(tree.groups, id).has(input.parent_id)
    )
      throw new FactorError('不能将分组移动到自身或子组中');
    if (
      tree.groups.some(
        (g) =>
          g.id !== id &&
          g.parent_id === input.parent_id &&
          g.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      throw new FactorError('同级分组名称已存在', 409);
    const group: FactorGroup = {
      id,
      name,
      parent_id: input.parent_id,
      builtin: false,
    };
    const groups = tree.groups
      .filter((g) => !g.builtin)
      .map((g) => (g.id === id ? group : g));
    if (!existing) groups.push(group);
    await this.put(
      'quant_factor_groups',
      actor,
      { id: 'tree', groups },
      tree.revision,
    );
    return {
      revision: tree.revision + 1,
      groups: [...FACTOR_GROUPS, ...groups],
    };
  }

  async deleteGroup(actor: string, id: string, revision: number) {
    const tree = await this.groups();
    if (tree.revision !== revision)
      throw new FactorError('分组已被修改，请重新加载', 409);
    const group = tree.groups.find((g) => g.id === id);
    if (!group) throw new FactorError('分组不存在', 404);
    if (group.builtin) throw new FactorError('固定分组不能删除', 403);
    const removed = groupDescendants(tree.groups, id);
    const groups = tree.groups.filter((g) => !g.builtin && !removed.has(g.id));
    // Canonical reads resolve removed group IDs to 未分类. This single CAS makes
    // subtree deletion atomic without partial multi-table updates or data loss.
    await this.put(
      'quant_factor_groups',
      actor,
      { id: 'tree', groups },
      revision,
    );
    return { revision: revision + 1, groups: [...FACTOR_GROUPS, ...groups] };
  }

  async save(
    actor: string,
    draft: FactorDraft,
    id: string = randomUUID(),
    revision = 0,
  ): Promise<FactorDetail> {
    if (builtinDetail(id))
      throw new FactorError('内置因子为只读，请复制为自定义因子后修改', 403);
    const previous = revision ? await this.detail(id) : null;
    if (previous && previous.revision !== revision)
      throw new FactorError('记录已被修改，请重新加载后保存', 409);
    const groupId = draft.group_id ?? previous?.group_id ?? UNGROUPED;
    if (!(await this.groups()).groups.some((g) => g.id === groupId))
      throw new FactorError('分组不存在，请重新选择');
    const next: FactorDetail = {
      ...draft,
      group_id: groupId,
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
    if (builtinDetail(id))
      throw new FactorError(
        '内置因子已有固定版本，请复制后发布自定义版本',
        403,
      );
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
    const builtin = builtinVersion(id);
    if (builtin) return structuredClone(builtin);
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
