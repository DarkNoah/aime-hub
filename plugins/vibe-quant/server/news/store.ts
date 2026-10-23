import type {
  NewsArticle,
  NewsPage,
  NewsSource,
  NewsSourceState,
  NewsSourceView,
  NewsSummary,
} from '../../news-types.js';
import type { QuantConfig } from '../config.js';
import { ClickHouseClient, timeSql, versionSql } from '../clickhouse-client.js';
import { newsSources } from './catalog.js';
import { createHash } from 'node:crypto';

const articleColumns = `id String, sourceId String, sourceName String, industry LowCardinality(String),
  url String, title String, summary String, publishedAt Nullable(Float64), publishedRaw String,
  discoveredAt Float64, sortAt Float64, contentStatus LowCardinality(String), contentFetchedAt Nullable(Float64),
  contentUrl String, contentProvider String, contentTruncated Bool, contentError String, attempts UInt32, nextRetryAt Float64`;
const sourceColumns =
  'id String, name String, industry String, url String, enabled Bool, deleted Bool, failureCount UInt32, lastError String, autoDisabled Bool, contentMode String';
const stateColumns = `sourceId String, lastPollAt Float64, lastSuccessAt Float64, nextPollAt Float64,
  failures UInt32, error String, etag String, lastModified String, itemCount UInt32`;
export type NewsQuery = {
  industry?: string;
  source?: string;
  q?: string;
  before?: { time: number; id: string };
  limit: number;
};
const jsonLines = (rows: unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join('\n');
const metadata = (article: NewsArticle) => {
  const { content, ...row } = article;
  void content;
  return row;
};
const lock = 'news:collector';

export class NewsStore extends ClickHouseClient {
  constructor(config: QuantConfig) {
    super({ ...config, clickhouseDatabase: config.newsDatabase });
  }

  async initialize(sources = newsSources) {
    await this.request(
      `CREATE DATABASE IF NOT EXISTS \`${this.config.clickhouseDatabase}\``,
    );
    for (const [name, columns, key] of [
      ['news_articles', articleColumns, 'id'],
      ['news_contents', 'id String, content String', 'id'],
      ['news_sources', sourceColumns, 'id'],
      ['news_source_state', stateColumns, 'sourceId'],
      [
        'news_lease',
        'id String, ownerId String, expiresAt Float64, heartbeatAt Float64',
        'id',
      ],
    ])
      await this
        .request(`CREATE TABLE IF NOT EXISTS ${this.table(name)} (${columns}, version UInt64)
      ENGINE = ReplacingMergeTree(version) ORDER BY ${key}`);
    for (const [column, after] of [
      ['deleted Bool DEFAULT false', 'enabled'],
      ['failureCount UInt32 DEFAULT 0', 'deleted'],
      ["lastError String DEFAULT ''", 'failureCount'],
      ['autoDisabled Bool DEFAULT false', 'lastError'],
      ["contentMode String DEFAULT 'page'", 'autoDisabled'],
    ])
      await this.request(
        `ALTER TABLE ${this.table('news_sources')} ADD COLUMN IF NOT EXISTS ${column} AFTER ${after}`,
      );
    if (sources.length)
      await this.execute(
        `INSERT INTO ${this.table('news_sources')}
      SELECT *, ${versionSql} FROM input('${sourceColumns}')
      WHERE id NOT IN (SELECT id FROM ${this.table('news_sources')} FINAL) FORMAT JSONEachRow`,
        {},
        jsonLines(sources.map((source) => ({ ...source, deleted: false }))),
        lock,
      );
  }

  private fence() {
    return `EXISTS (SELECT 1 FROM ${this.table('news_lease')} FINAL WHERE id = 'collector'
      AND ownerId = {owner:String} AND expiresAt > ${timeSql})`;
  }
  async acquire(owner: string) {
    const result = await this.execute(
      `INSERT INTO ${this.table('news_lease')}
      SELECT 'collector', {owner:String}, ${timeSql} + 90, ${timeSql}, ${versionSql}
      WHERE NOT EXISTS (SELECT 1 FROM ${this.table('news_lease')} FINAL
        WHERE id = 'collector' AND ownerId != {owner:String} AND expiresAt > ${timeSql})`,
      { owner },
      undefined,
      lock,
    );
    return result.writtenRows > 0;
  }
  async release(owner: string) {
    await this.execute(
      `INSERT INTO ${this.table('news_lease')}
      SELECT id, ownerId, 0, heartbeatAt, ${versionSql} FROM ${this.table('news_lease')} FINAL
      WHERE id = 'collector' AND ownerId = {owner:String}`,
      { owner },
      undefined,
      lock,
    );
  }
  async collector() {
    const [row] = await this.rows<{
      active: boolean;
      heartbeatAt: number;
    }>(`SELECT expiresAt > ${timeSql} AS active, heartbeatAt
      FROM ${this.table('news_lease')} FINAL WHERE id = 'collector'`);
    return row
      ? { ...row, active: Boolean(row.active) }
      : { active: false, heartbeatAt: null };
  }
  async sources(): Promise<NewsSourceView[]> {
    const [sources, states] = await Promise.all([
      this.rows<NewsSource>(
        `SELECT * EXCEPT (version, deleted) FROM ${this.table('news_sources')} FINAL WHERE NOT deleted ORDER BY industry, name`,
      ),
      this.rows<NewsSourceState>(
        `SELECT * EXCEPT version FROM ${this.table('news_source_state')} FINAL`,
      ),
    ]);
    const byId = new Map(states.map((state) => [state.sourceId, state]));
    return sources.map((source) => ({
      ...source,
      state: byId.get(source.id) ?? null,
    }));
  }
  async setEnabled(id: string, enabled: boolean) {
    return !!(await this.updateSource(id, { enabled }));
  }
  async createSource(
    input: Pick<NewsSource, 'name' | 'industry' | 'url' | 'enabled'> &
      Partial<Pick<NewsSource, 'contentMode'>>,
  ) {
    const id = createHash('sha256')
      .update(input.url)
      .digest('hex')
      .slice(0, 24);
    const result = await this.execute(
      `INSERT INTO ${this.table('news_sources')}
      SELECT *, ${versionSql} FROM input('${sourceColumns}')
      WHERE NOT EXISTS (SELECT 1 FROM ${this.table('news_sources')} FINAL WHERE NOT deleted AND (id = {id:String} OR url = {url:String})) FORMAT JSONEachRow`,
      { id, url: input.url },
      jsonLines([
        {
          id,
          ...input,
          contentMode: input.contentMode ?? 'page',
          deleted: false,
          failureCount: 0,
          lastError: '',
          autoDisabled: false,
        },
      ]),
      lock,
    );
    if (!result.writtenRows) return null;
    await this.resetSourcePoll(id);
    return this.source(id);
  }
  async source(id: string): Promise<NewsSourceView | null> {
    const [row] = await this.rows<NewsSource>(
      `SELECT * EXCEPT (version, deleted) FROM ${this.table('news_sources')} FINAL WHERE id = {id:String} AND NOT deleted`,
      { id },
    );
    if (!row) return null;
    const [state] = await this.rows<NewsSourceState>(
      `SELECT * EXCEPT version FROM ${this.table('news_source_state')} FINAL WHERE sourceId = {id:String}`,
      { id },
    );
    return { ...row, state: state ?? null };
  }
  async updateSource(
    id: string,
    input: Partial<
      Pick<NewsSource, 'name' | 'industry' | 'url' | 'enabled' | 'contentMode'>
    >,
  ) {
    const result = await this.execute(
      `INSERT INTO ${this.table('news_sources')}
      SELECT id, if({hasName:Bool}, {name:String}, name), if({hasIndustry:Bool}, {industry:String}, industry),
        if({hasUrl:Bool}, {url:String}, url), if({hasEnabled:Bool}, {enabled:Bool}, enabled), deleted,
        if({resume:Bool}, 0, failureCount), if({resume:Bool}, '', lastError), if({resume:Bool}, false, autoDisabled),
        if({hasMode:Bool}, {mode:String}, contentMode), ${versionSql}
      FROM ${this.table('news_sources')} FINAL WHERE id = {id:String} AND NOT deleted
      AND (NOT {hasUrl:Bool} OR NOT EXISTS (SELECT 1 FROM ${this.table('news_sources')} FINAL WHERE NOT deleted AND id != {id:String} AND url = {url:String}))`,
      {
        id,
        hasName: String(input.name !== undefined),
        name: input.name ?? '',
        hasIndustry: String(input.industry !== undefined),
        industry: input.industry ?? '',
        hasUrl: String(input.url !== undefined),
        url: input.url ?? '',
        hasEnabled: String(input.enabled !== undefined),
        enabled: String(input.enabled ?? false),
        resume: String(input.enabled === true),
        hasMode: String(input.contentMode !== undefined),
        mode: input.contentMode ?? 'page',
      },
      undefined,
      lock,
    );
    if (!result.writtenRows) return null;
    if (
      input.enabled === true ||
      input.url !== undefined ||
      input.contentMode !== undefined
    )
      await this.resetSourcePoll(id);
    return this.source(id);
  }
  private async resetSourcePoll(id: string) {
    await this.execute(
      `INSERT INTO ${this.table('news_source_state')}
      SELECT sourceId, lastPollAt, lastSuccessAt, 0, 0, '', '', '', itemCount, ${versionSql} FROM ${this.table('news_source_state')} FINAL WHERE sourceId = {id:String}`,
      { id },
      undefined,
      lock,
    );
  }
  async deleteSource(id: string) {
    const result = await this.execute(
      `INSERT INTO ${this.table('news_sources')}
      SELECT * REPLACE (false AS enabled, true AS deleted, ${versionSql} AS version)
      FROM ${this.table('news_sources')} FINAL WHERE id = {id:String} AND NOT deleted`,
      { id },
      undefined,
      lock,
    );
    return result.writtenRows > 0;
  }
  async recordSourceResult(
    id: string,
    error: string,
    threshold: number,
    owner: string,
    feed = false,
  ) {
    // Feed successes do not erase body failures. Updates are atomic even when
    // feed polling and body extraction finish concurrently for the same source.
    await this.execute(
      `INSERT INTO ${this.table('news_sources')}
      SELECT id, name, industry, url,
        if({failed:Bool} AND ({feed:Bool} OR failureCount + 1 >= {threshold:UInt32}), false, enabled), deleted,
        if({failed:Bool}, if({feed:Bool}, {threshold:UInt32}, failureCount + 1), 0), {error:String},
        {failed:Bool} AND ({feed:Bool} OR failureCount + 1 >= {threshold:UInt32}), contentMode, ${versionSql}
      FROM ${this.table('news_sources')} FINAL WHERE id = {id:String} AND enabled AND NOT deleted AND ${this.fence()}`,
      {
        id,
        error,
        failed: String(!!error),
        threshold: String(threshold),
        owner,
        feed: String(feed),
      },
      undefined,
      lock,
    );
  }
  async requeueArticles(ids: string[]) {
    if (!ids.length) return 0;
    const result = await this.execute(
      `INSERT INTO ${this.table('news_articles')}
      SELECT * REPLACE ('pending' AS contentStatus, 'CONTENT_REPROCESSING' AS contentError, false AS contentTruncated, 1 AS nextRetryAt, 0 AS attempts, ${versionSql} AS version)
      FROM ${this.table('news_articles')} FINAL WHERE id IN (SELECT arrayJoin(JSONExtract({ids:String}, 'Array(String)'))) AND contentStatus = 'ready'`,
      { ids: JSON.stringify(ids) },
      undefined,
      lock,
    );
    return result.writtenRows;
  }
  async saveSource(state: NewsSourceState, owner: string) {
    await this.execute(
      `INSERT INTO ${this.table('news_source_state')}
      SELECT *, ${versionSql} FROM input('${stateColumns}') WHERE ${this.fence()} FORMAT JSONEachRow`,
      { owner },
      jsonLines([state]),
      lock,
    );
  }
  async discover(items: NewsArticle[], owner: string) {
    if (!items.length) return;
    const bodies = items.filter(
      (item) => item.contentStatus === 'ready' && item.content.trim(),
    );
    if (bodies.length)
      // Persist inline bodies before publishing ready metadata; retries remain idempotent.
      await this.execute(
        `INSERT INTO ${this.table('news_contents')}
        SELECT *, ${versionSql} FROM input('id String, content String') WHERE ${this.fence()}
        AND id NOT IN (SELECT id FROM ${this.table('news_articles')} FINAL) FORMAT JSONEachRow`,
        { owner },
        jsonLines(bodies.map(({ id, content }) => ({ id, content }))),
        lock,
      );
    // Never replace a previously seen article with a fresh pending RSS row.
    await this.execute(
      `INSERT INTO ${this.table('news_articles')}
      SELECT *, ${versionSql} FROM input('${articleColumns}') WHERE ${this.fence()}
      AND id NOT IN (SELECT id FROM ${this.table('news_articles')} FINAL WHERE sourceId = {source:String})
      FORMAT JSONEachRow`,
      { owner, source: items[0].sourceId },
      jsonLines(items.map(metadata)),
      lock,
    );
  }
  async pending(limit: number): Promise<NewsArticle[]> {
    const due = `SELECT * EXCEPT version FROM ${this.table('news_articles')} FINAL
      WHERE contentStatus != 'ready' AND nextRetryAt <= ${timeSql}
      AND sourceId IN (SELECT id FROM ${this.table('news_sources')} FINAL WHERE enabled AND NOT deleted AND contentMode = 'page')`;
    // Reserve half the batch for fresh news, while older items and due retries
    // keep making progress even when a busy source continually adds headlines.
    const [fresh, waiting] = await Promise.all([
      this.rows<Omit<NewsArticle, 'content'>>(
        `${due} ORDER BY sortAt DESC, id LIMIT {limit:UInt32}`,
        { limit: String(Math.floor(limit / 2)) },
      ),
      this.rows<Omit<NewsArticle, 'content'>>(
        `${due} ORDER BY if(nextRetryAt > 0, nextRetryAt, discoveredAt), id LIMIT {limit:UInt32}`,
        { limit: String(limit) },
      ),
    ]);
    const rows = [
      ...new Map([...fresh, ...waiting].map((row) => [row.id, row])).values(),
    ].slice(0, limit);
    return rows.map((row) => ({ ...row, content: '' }));
  }
  async saveContent(article: NewsArticle, owner: string) {
    if (article.contentStatus === 'ready')
      await this.execute(
        `INSERT INTO ${this.table('news_contents')}
      SELECT *, ${versionSql} FROM input('id String, content String') WHERE ${this.fence()} FORMAT JSONEachRow`,
        { owner },
        jsonLines([{ id: article.id, content: article.content }]),
        lock,
      );
    const row = metadata(article);
    await this.execute(
      `INSERT INTO ${this.table('news_articles')}
      SELECT *, ${versionSql} FROM input('${articleColumns}') WHERE ${this.fence()} FORMAT JSONEachRow`,
      { owner },
      jsonLines([row]),
      lock,
    );
  }
  async counts() {
    const [row] = await this.rows<{
      total: number;
      ready: number;
      pending: number;
      failed: number;
    }>(`SELECT
      toUInt32(count()) AS total, toUInt32(countIf(contentStatus = 'ready')) AS ready,
      toUInt32(countIf(contentStatus = 'pending')) AS pending, toUInt32(countIf(contentStatus = 'failed')) AS failed
      FROM ${this.table('news_articles')} FINAL`);
    return row;
  }
  async list(query: NewsQuery): Promise<NewsPage> {
    const rows = await this.rows<NewsSummary>(
      `SELECT * EXCEPT (version, publishedRaw) FROM ${this.table('news_articles')} FINAL
      WHERE ({industry:String} = '' OR industry = {industry:String})
        AND ({source:String} = '' OR sourceId = {source:String})
        AND ({q:String} = '' OR positionCaseInsensitiveUTF8(title, {q:String}) > 0 OR positionCaseInsensitiveUTF8(summary, {q:String}) > 0)
        AND ({before:Float64} = 0 OR (sortAt, id) < ({before:Float64}, {id:String}))
      ORDER BY sortAt DESC, id DESC LIMIT {limit:UInt32}`,
      {
        industry: query.industry ?? '',
        source: query.source ?? '',
        q: query.q ?? '',
        before: String(query.before?.time ?? 0),
        id: query.before?.id ?? '',
        limit: String(query.limit + 1),
      },
    );
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({ time: last.sortAt, id: last.id }),
            ).toString('base64url')
          : null,
    };
  }
  async article(id: string): Promise<NewsArticle | null> {
    const [row] = await this.rows<Omit<NewsArticle, 'content'>>(
      `SELECT * EXCEPT version FROM ${this.table('news_articles')} FINAL WHERE id = {id:String}`,
      { id },
    );
    if (!row) return null;
    const [body] = await this.rows<{ content: string }>(
      `SELECT content FROM ${this.table('news_contents')} FINAL WHERE id = {id:String}`,
      { id },
    );
    return { ...row, content: body?.content ?? '' };
  }
}
