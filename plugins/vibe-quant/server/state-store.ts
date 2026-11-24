import type { Engine, Instrument, SyncStatus, WatchItem } from '../shared.js';
import {
  ClickHouseClient,
  ClickHouseError,
  timeSql,
  versionSql,
} from './clickhouse-client.js';
import {
  historicalInstrument,
  searchTerms,
  symbolsWithBars,
} from './symbols.js';

type WatchRow = {
  userId: string;
  symbol: string;
  enabled: boolean;
  deleted: boolean;
  createdAt: number;
};
export type CatalogRow = {
  engine: Engine;
  symbol: string;
  metadata: Instrument;
};

/** Durable plugin state shared by every service using this ClickHouse database. */
export class StateStore extends ClickHouseClient {
  private readonly archived = new Map<
    Engine,
    { expires: number; items: Promise<Instrument[]> }
  >();

  async initialize() {
    const [{ version }] = await this.rows<{ version: string }>(
      'SELECT version() AS version',
    );
    const [major, minor] = version.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 8))
      throw new Error('Vibe Quant 需要 ClickHouse 24.8 或更新版本');
    const tables = {
      quant_instruments:
        'engine LowCardinality(String), symbol String, metadata String, version UInt64',
      quant_watchlist:
        'userId String, symbol String, enabled Bool, deleted Bool, createdAt Float64, version UInt64',
      quant_status:
        'instanceId String, engine LowCardinality(String), payload String, updatedAt Float64, version UInt64',
      quant_leases:
        'engine LowCardinality(String), ownerId String, expiresAt Float64, version UInt64',
      quant_migrations: 'id String, version UInt64',
      quant_strategy_subscriptions:
        'userId String, sessionId String, engine LowCardinality(String), symbol String, expiresAt Float64, version UInt64',
    };
    const keys = {
      quant_instruments: '(engine, symbol)',
      quant_watchlist: '(userId, symbol)',
      quant_status: '(engine, instanceId)',
      quant_leases: 'engine',
      quant_migrations: 'id',
      quant_strategy_subscriptions: '(userId, sessionId, engine, symbol)',
    };
    for (const name of Object.keys(tables) as (keyof typeof tables)[]) {
      try {
        await this.request(`SELECT * FROM ${this.table(name)} LIMIT 0`);
      } catch (error) {
        if (!(error instanceof ClickHouseError) || error.code !== 60)
          throw error;
        // No time partitions: replacements and tombstones must share a partition.
        await this.request(
          `CREATE TABLE IF NOT EXISTS ${this.table(name)} (${tables[name]})
           ENGINE = ReplacingMergeTree(version) ORDER BY ${keys[name]}`,
        );
      }
    }
  }

  private catalog() {
    return this.table('quant_instruments');
  }
  private watches() {
    return this.table('quant_watchlist');
  }

  async instrument(engine: Engine, symbol: string) {
    const [row] = await this.rows<{ metadata: string }>(
      `SELECT metadata FROM ${this.catalog()} FINAL
       WHERE engine = {engine:String} AND symbol = {symbol:String}`,
      { engine, symbol },
    );
    return row ? (JSON.parse(row.metadata) as Instrument) : undefined;
  }

  async viewInstrument(
    engine: Engine,
    symbol: string,
  ): Promise<Instrument | undefined> {
    const instrument = await this.instrument(engine, symbol);
    if (instrument && !instrument.expired) return instrument;
    const saved = await this.rows(
      `SELECT 1 FROM ${this.table('bars')} WHERE engine = {engine:String} AND symbol = {symbol:String} LIMIT 1`,
      { engine, symbol },
    );
    return saved.length ? historicalInstrument(symbol, instrument) : undefined;
  }

  private archivedInstruments(engine: Engine): Promise<Instrument[]> {
    const cached = this.archived.get(engine);
    if (cached && cached.expires > Date.now()) return cached.items;
    // The bars table also contains history imported before there was a catalog or an
    // archive worker. Read only the indexed identifiers and share the lookup across searches.
    const items = this.rows<{ symbol: string; metadata: string }>(
      `SELECT saved.symbol AS symbol, known.metadata AS metadata
       FROM (SELECT DISTINCT symbol FROM ${this.table('bars')} WHERE engine = {engine:String}) AS saved
       LEFT JOIN (SELECT symbol, metadata FROM ${this.catalog()} FINAL WHERE engine = {engine:String}) AS known
         ON saved.symbol = known.symbol
       WHERE known.metadata = '' OR JSONExtractBool(known.metadata, 'expired')
       ORDER BY saved.symbol SETTINGS join_use_nulls = 0, optimize_distinct_in_order = 1`,
      { engine },
    )
      .then((rows) =>
        rows.map(({ symbol, metadata }) =>
          historicalInstrument(
            symbol,
            metadata ? JSON.parse(metadata) : undefined,
          ),
        ),
      )
      .catch((error: unknown) => {
        if (this.archived.get(engine)?.items === items)
          this.archived.delete(engine);
        throw error;
      });
    this.archived.set(engine, { expires: Date.now() + 60_000, items });
    return items;
  }

  async search(
    engine: Engine,
    query: string,
    kind: string,
  ): Promise<Instrument[]> {
    return (await this.searchPage(engine, query, kind)).items;
  }

  async searchPage(
    engine: Engine,
    query: string,
    kind: string,
    cursor?: { rank: number; symbol: string },
    includeArchived = false,
  ): Promise<{ items: Instrument[]; nextCursor: string | null }> {
    const { term, continuous } = searchTerms(query);
    const category = continuous ? 'continuous' : kind;
    const limit = 60;
    const items: { instrument: Instrument; rank: number }[] = [];
    if (!cursor || cursor.rank < 2) {
      const rows = await this.rows<{ metadata: string; rank: number }>(
        `SELECT metadata, if(splitByChar('.', symbol)[2] ILIKE {prefix:String}, 0, 1) AS rank
         FROM ${this.catalog()} FINAL
         WHERE engine = {engine:String} AND NOT JSONExtractBool(metadata, 'expired')
           AND ({kind:String} = 'all' OR JSONExtractString(metadata, 'kind') = {kind:String})
           AND (symbol ILIKE {term:String} OR JSONExtractString(metadata, 'name') ILIKE {term:String})
           ${cursor ? 'AND (rank, symbol) > ({rank:UInt8}, {after:String})' : ''}
         ORDER BY rank, symbol LIMIT ${limit + 1}`,
        {
          engine,
          kind: category,
          term: `%${term}%`,
          prefix: term,
          ...(cursor
            ? { rank: String(cursor.rank), after: cursor.symbol }
            : {}),
        },
      );
      for (const row of rows)
        items.push({ instrument: JSON.parse(row.metadata), rank: row.rank });
    }
    if (includeArchived && items.length <= limit) {
      const archived = await this.archivedInstruments(engine);
      const needle = term.replace(/\\([%_\\])/g, '$1').toLowerCase();
      // Another writer may have put a cached contract back into the live catalog.
      const liveSymbols = new Set(
        items.map(({ instrument }) => instrument.symbol),
      );
      for (const instrument of archived) {
        if (liveSymbols.has(instrument.symbol)) continue;
        if (cursor?.rank === 2 && instrument.symbol <= cursor.symbol) continue;
        if (category !== 'all' && category !== instrument.kind) continue;
        if (
          !instrument.symbol.toLowerCase().includes(needle) &&
          !instrument.name.toLowerCase().includes(needle)
        )
          continue;
        items.push({ instrument, rank: 2 });
        if (items.length > limit) break;
      }
    }
    const last = items[limit - 1];
    return {
      items: items.slice(0, limit).map((row) => row.instrument),
      nextCursor:
        items.length > limit ? `${last.rank}:${last.instrument.symbol}` : null,
    };
  }

  async watchlist(userId: string, engine: Engine): Promise<WatchItem[]> {
    const rows = await this.rows<WatchRow>(
      `SELECT * EXCEPT version FROM ${this.watches()} FINAL
       WHERE userId = {userId:String} AND NOT deleted ORDER BY createdAt, symbol`,
      { userId },
    );
    if (!rows.length) return [];
    const catalog = await this.rows<{ symbol: string; metadata: string }>(
      `SELECT symbol, metadata FROM ${this.catalog()} FINAL
       WHERE symbol IN (SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')))
       ORDER BY (engine = {engine:String}) DESC, version DESC LIMIT 1 BY symbol`,
      { engine, symbols: JSON.stringify(rows.map((row) => row.symbol)) },
    );
    const instruments = new Map(
      catalog.map((row) => [
        row.symbol,
        JSON.parse(row.metadata) as Instrument,
      ]),
    );
    const missing = rows
      .filter((row) => !instruments.has(row.symbol))
      .map((row) => row.symbol);
    for (const symbol of await symbolsWithBars(this, engine, missing)) {
      instruments.set(symbol, historicalInstrument(symbol));
    }
    return rows.flatMap((row) => {
      const item = instruments.get(row.symbol);
      return item ? [{ ...item, enabled: row.enabled }] : [];
    });
  }

  async owns(userId: string, symbol: string) {
    const rows = await this.rows(
      `SELECT 1 FROM ${this.watches()} FINAL
       WHERE userId = {userId:String} AND symbol = {symbol:String} AND NOT deleted`,
      { userId, symbol },
    );
    return rows.length > 0;
  }

  async setWatch(
    userId: string,
    symbol: string,
    enabled: boolean,
    mode: 'add' | 'update' | 'delete',
  ): Promise<'ok' | 'missing' | 'limit'> {
    // One conditional INSERT plus a shared query ID makes the capacity check
    // atomic on this server, even when services use different database accounts.
    const existing = `SELECT createdAt FROM ${this.watches()} FINAL
      WHERE userId = {userId:String} AND symbol = {symbol:String} AND NOT deleted`;
    const result = await this.execute(
      `INSERT INTO ${this.watches()}
       SELECT {userId:String}, {symbol:String}, {enabled:Bool}, {deleted:Bool},
         coalesce((SELECT minOrNull(createdAt) FROM (${existing})), ${timeSql}), ${versionSql}
       WHERE ({requireExisting:Bool} = false OR EXISTS (${existing}))
         AND ({enabled:Bool} = false OR {deleted:Bool} = true OR
           (SELECT count(DISTINCT symbol) FROM (
            SELECT symbol FROM ${this.watches()} FINAL
            WHERE enabled AND NOT deleted
              AND symbol IN (SELECT symbol FROM ${this.catalog()} FINAL
                WHERE engine = {engine:String} AND NOT JSONExtractBool(metadata, 'expired'))
            UNION ALL SELECT symbol FROM ${this.table('quant_strategy_subscriptions')} FINAL
              WHERE engine = {engine:String} AND expiresAt > ${timeSql}
           ) WHERE symbol != {symbol:String})
             < {limit:UInt32})`,
      {
        userId,
        symbol,
        engine: this.config.engine,
        enabled: String(enabled),
        deleted: String(mode === 'delete'),
        requireExisting: String(mode !== 'add'),
        limit: String(this.config.maxSubscriptions),
      },
      undefined,
      'watchlist',
    );
    if (result.writtenRows) return 'ok';
    return mode !== 'add' && !(await this.owns(userId, symbol))
      ? 'missing'
      : 'limit';
  }

  async subscriptions(engine: Engine): Promise<string[]> {
    const rows = await this.rows<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM (
       SELECT symbol FROM ${this.watches()} FINAL
       WHERE enabled AND NOT deleted AND symbol IN
         (SELECT symbol FROM ${this.catalog()} FINAL
          WHERE engine = {engine:String} AND NOT JSONExtractBool(metadata, 'expired'))
       UNION ALL SELECT symbol FROM ${this.table('quant_strategy_subscriptions')} FINAL
         WHERE engine = {engine:String} AND expiresAt > ${timeSql})
       ORDER BY symbol`,
      { engine },
    );
    return rows.map((row) => row.symbol);
  }

  async saveCatalog(engine: Engine, instruments: Instrument[]) {
    if (!instruments.length) return;
    await this.execute(
      `INSERT INTO ${this.catalog()}
       SELECT {engine:String}, symbol, metadata, ${versionSql}
       FROM input('symbol String, metadata String') FORMAT JSONEachRow`,
      { engine },
      instruments
        .map((item) =>
          JSON.stringify({
            symbol: item.symbol,
            metadata: JSON.stringify(item),
          }),
        )
        .join('\n'),
      'catalog',
    );
    this.archived.delete(engine);
  }

  async completeCatalog(engine: Engine, symbols: string[]) {
    await this.execute(
      `INSERT INTO ${this.catalog()}
       SELECT engine, symbol, JSONMergePatch(metadata, '{"expired":true}'), ${versionSql}
       FROM ${this.catalog()} FINAL WHERE engine = {engine:String}
         AND NOT JSONExtractBool(metadata, 'expired')
         AND symbol NOT IN (SELECT symbol FROM input('symbol String'))
       FORMAT JSONEachRow`,
      { engine },
      symbols.map((symbol) => JSON.stringify({ symbol })).join('\n'),
      'catalog',
    );
    this.archived.delete(engine);
  }

  async catalogCount(engine: Engine) {
    const [{ count }] = await this.rows<{ count: number }>(
      `SELECT toUInt32(count()) AS count FROM ${this.catalog()} FINAL WHERE engine = {engine:String}`,
      { engine },
    );
    return count;
  }

  async saveStatus(instanceId: string, status: SyncStatus) {
    await this.execute(
      `INSERT INTO ${this.table('quant_status')}
       SELECT {instanceId:String}, {engine:String}, {payload:String}, ${timeSql}, ${versionSql}`,
      { instanceId, engine: status.engine, payload: JSON.stringify(status) },
    );
  }

  async writerStatus(engine: Engine): Promise<SyncStatus | undefined> {
    const [row] = await this.rows<{ payload: string }>(
      `SELECT payload FROM ${this.table('quant_status')} FINAL WHERE engine = {engine:String}
       AND instanceId IN (SELECT ownerId FROM ${this.table('quant_leases')} FINAL
         WHERE engine = {engine:String} AND expiresAt > ${timeSql}) LIMIT 1`,
      { engine },
    );
    return row ? JSON.parse(row.payload) : undefined;
  }

  async acquireLease(engine: Engine, ownerId: string) {
    const result = await this.execute(
      `INSERT INTO ${this.table('quant_leases')}
       SELECT {engine:String}, {ownerId:String}, ${timeSql} + {ttl:UInt32}, ${versionSql}
       WHERE NOT EXISTS (SELECT 1 FROM ${this.table('quant_leases')} FINAL
         WHERE engine = {engine:String} AND ownerId != {ownerId:String} AND expiresAt > ${timeSql})`,
      {
        engine,
        ownerId,
        ttl: String(Math.max(60, this.config.flushSeconds * 3)),
      },
      undefined,
      `collector:${engine}`,
    );
    return result.writtenRows > 0;
  }

  async releaseLease(engine: Engine, ownerId: string) {
    await this.execute(
      `INSERT INTO ${this.table('quant_leases')}
       SELECT engine, ownerId, 0, ${versionSql} FROM ${this.table('quant_leases')} FINAL
       WHERE engine = {engine:String} AND ownerId = {ownerId:String}`,
      { engine, ownerId },
      undefined,
      `collector:${engine}`,
    );
  }

  async migrated(id: string) {
    return (
      (
        await this.rows(
          `SELECT 1 FROM ${this.table('quant_migrations')} FINAL WHERE id = {id:String}`,
          { id },
        )
      ).length > 0
    );
  }

  async importLegacy(
    id: string,
    catalog: CatalogRow[],
    watches: Omit<WatchRow, 'deleted'>[],
    status?: SyncStatus,
  ) {
    if (await this.migrated(id)) return;
    for (let offset = 0; offset < catalog.length; offset += 1000) {
      await this.execute(
        `INSERT INTO ${this.catalog()}
         SELECT engine, symbol, metadata, ${versionSql}
         FROM input('engine String, symbol String, metadata String')
         WHERE (engine, symbol) NOT IN (SELECT engine, symbol FROM ${this.catalog()} FINAL)
         FORMAT JSONEachRow`,
        {},
        catalog
          .slice(offset, offset + 1000)
          .map((row) =>
            JSON.stringify({ ...row, metadata: JSON.stringify(row.metadata) }),
          )
          .join('\n'),
        'catalog',
      );
    }
    for (let offset = 0; offset < watches.length; offset += 1000) {
      await this.execute(
        `INSERT INTO ${this.watches()}
         SELECT userId, symbol, enabled, false, createdAt, ${versionSql}
         FROM input('userId String, symbol String, enabled Bool, createdAt Float64')
         WHERE (userId, symbol) NOT IN (SELECT userId, symbol FROM ${this.watches()} FINAL)
         FORMAT JSONEachRow`,
        {},
        watches
          .slice(offset, offset + 1000)
          .map((row) => JSON.stringify(row))
          .join('\n'),
        'watchlist',
      );
    }
    if (status) await this.saveStatus(`legacy:${id}`, status);
    await this.execute(
      `INSERT INTO ${this.table('quant_migrations')} SELECT {id:String}, ${versionSql}`,
      { id },
    );
  }
}
