import { UsageRecord } from '@aime/db';
import {
  tokenFields,
  type UsageQuery,
  type UsageRecordsQuery,
  type UsageRecordPage,
  type UsageSummary,
  type UsageTotals,
} from '@aime/shared/usage';
import type { DataSource } from 'typeorm';

const columns = {
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  totalTokens: 'total_tokens',
  cachedInputTokens: 'cached_input_tokens',
  cacheCreationInputTokens: 'cache_creation_input_tokens',
  reasoningTokens: 'reasoning_tokens',
};
const aggregate = `count(*)::float8 AS requests, count(r.total_tokens)::float8 AS "reportedRequests",
  avg(r.duration_ms)::float8 AS "averageDurationMs", ${tokenFields.map((field) => `coalesce(sum(r.${columns[field]}), 0)::float8 AS "${field}"`).join(', ')}`;

function filters(input: UsageQuery) {
  const params: unknown[] = [input.from, input.to, input.timezone];
  const conditions = [
    'r.created_at >= ($1::date::timestamp AT TIME ZONE $3)',
    'r.created_at < (($2::date + 1)::timestamp AT TIME ZONE $3)',
  ];
  for (const [field, column] of [
    ['userId', 'user_id'],
    ['projectId', 'project_id'],
    ['providerId', 'provider_id'],
    ['model', 'model'],
  ] as const) {
    const value = input[field];
    if (value === '__none__') conditions.push(`r.${column} IS NULL`);
    else if (value) {
      params.push(value);
      conditions.push(`r.${column} = $${params.length}`);
    }
  }
  return { params, where: conditions.join(' AND ') };
}

export class UsageService {
  constructor(private readonly database: DataSource) {}

  /** A step ID is allocated before execution; repeated delivery cannot double count it. */
  async record(record: UsageRecord): Promise<void> {
    try {
      await this.database
        .getRepository(UsageRecord)
        .createQueryBuilder()
        .insert()
        .values(record)
        .orIgnore()
        .execute();
    } catch {
      // Accounting failure must not fail an otherwise successful chat or leak content.
      console.error('Failed to persist runtime usage', record.id);
    }
  }

  /** Recover the actor's last valid measurement when an older failed run erased UI usage. */
  async latestThreadUsage(threadId: string, agentId: string) {
    const rows: { totalTokens: number }[] = await this.database.query(
      `SELECT total_tokens::float8 AS "totalTokens" FROM usage_records
       WHERE thread_id = $1 AND agent_id = $2 AND total_tokens IS NOT NULL
       ORDER BY finished_at DESC, created_at DESC, id DESC LIMIT 1`,
      [threadId, agentId],
    );
    return rows[0];
  }

  async summary(input: UsageQuery): Promise<UsageSummary> {
    const { where, params } = filters(input);
    return this.database.transaction('REPEATABLE READ', async (manager) => {
      const query = <T>(sql: string): Promise<T[]> =>
        manager.query(sql, params);
      const totals = await query<UsageTotals>(
        `SELECT ${aggregate} FROM usage_records r WHERE ${where}`,
      );
      const daily = await query<
        UsageSummary['daily'][number]
      >(`SELECT to_char(r.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS date, ${aggregate}
        FROM usage_records r WHERE ${where} GROUP BY date ORDER BY date`);
      const heatmap = await query<
        UsageSummary['heatmap'][number]
      >(`SELECT extract(isodow FROM r.created_at AT TIME ZONE $3)::int AS weekday,
        extract(hour FROM r.created_at AT TIME ZONE $3)::int AS hour, coalesce(sum(r.total_tokens),0)::float8 AS "totalTokens", count(*)::float8 AS requests
        FROM usage_records r WHERE ${where} GROUP BY weekday, hour ORDER BY weekday, hour`);
      const users = await query<
        UsageSummary['users'][number]
      >(`SELECT r.user_id AS id, coalesce(u.name, u.username) AS name, ${aggregate}
        FROM usage_records r LEFT JOIN users u ON u.id = r.user_id WHERE ${where}
        GROUP BY r.user_id, u.name, u.username ORDER BY "totalTokens" DESC, requests DESC, r.user_id LIMIT 100`);
      const projects = await query<
        UsageSummary['projects'][number]
      >(`SELECT r.project_id AS id, p.name, ${aggregate}
        FROM usage_records r LEFT JOIN projects p ON p.id = r.project_id WHERE ${where}
        GROUP BY r.project_id, p.name ORDER BY "totalTokens" DESC, requests DESC, r.project_id NULLS LAST LIMIT 100`);
      const models = await query<
        UsageSummary['models'][number]
      >(`SELECT r.model AS id, r.model AS name, r.provider_id AS "providerId", p.name AS "providerName", ${aggregate}
        FROM usage_records r LEFT JOIN providers p ON p.id = r.provider_id WHERE ${where}
        GROUP BY r.model, r.provider_id, p.name ORDER BY "totalTokens" DESC, requests DESC, r.model, r.provider_id NULLS LAST LIMIT 100`);
      return { totals: totals[0], daily, heatmap, users, projects, models };
    });
  }

  async records(input: UsageRecordsQuery): Promise<UsageRecordPage> {
    const { params, where } = filters(input);
    let cursor = '';
    if (input.cursor) {
      params.push(input.cursor.createdAt, input.cursor.id);
      cursor = ` AND (r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(input.limit + 1);
    const rows: UsageRecordPage['items'] = await this.database.query(
      `SELECT r.id, r.created_at AS "createdAt", r.user_id AS "userId", coalesce(u.name,u.username) AS "userName",
      r.project_id AS "projectId", p.name AS "projectName", r.provider_id AS "providerId", v.name AS "providerName", r.model,
      r.thread_id AS "threadId", r.run_id AS "runId", r.agent_id AS "agentId", r.step_number AS "stepNumber", r.model_reference AS "modelReference",
      r.duration_ms AS "durationMs", r.finish_reason AS "finishReason", ${tokenFields.map((field) => `r.${columns[field]}::float8 AS "${field}"`).join(', ')}
      FROM usage_records r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN providers v ON v.id = r.provider_id
      WHERE ${where}${cursor} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, input.limit).map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }
}
