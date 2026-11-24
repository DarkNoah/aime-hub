import type { Engine } from '../../shared.js';
import type {
  ProductSyncContract,
  ProductSyncContractPage,
  ProductSyncOption,
  ProductSyncOverview,
  ProductSyncResult,
  ProductSyncTarget,
} from '../../product-sync-types.js';
import {
  ClickHouseClient,
  ClickHouseError,
  timeSql,
  versionSql,
} from '../clickhouse-client.js';

interface SelectionCounts {
  productKey: string;
  selected: boolean;
  selectedContracts: number;
}

interface ProductCounts {
  productKey: string;
  total: number;
  ready: number;
  directMatched: number;
  directReady: number;
}

const contractPageSize = 60;

export class ProductSyncStore extends ClickHouseClient {
  async initialize() {
    const tables = [
      {
        name: 'quant_product_sync_selections',
        columns:
          'engine LowCardinality(String), userId String, target String, productKey String, isContract Bool, selected Bool',
        order: '(engine, userId, target)',
      },
      {
        name: 'quant_product_sync_progress',
        columns:
          'engine LowCardinality(String), symbol String, latest Map(String, UInt32), firstBarAt UInt32, lastBarAt UInt32, outcome LowCardinality(String), nextCheckAt Float64',
        order: '(engine, symbol)',
      },
    ];
    for (const { name, columns, order } of tables) {
      try {
        await this.request(`SELECT * FROM ${this.table(name)} LIMIT 0`);
      } catch (error) {
        if (!(error instanceof ClickHouseError) || error.code !== 60)
          throw error;
        await this.request(`CREATE TABLE IF NOT EXISTS ${this.table(name)}
          (${columns}, version UInt64) ENGINE = ReplacingMergeTree(version) ORDER BY ${order}`);
      }
    }
  }

  /** Option product_id may be absent or identify the underlying. Listed
   * alphanumeric contracts carry their own family (notably MO versus IM).
   * Numeric ETF options are grouped using the qualified underlying ETF.
   * Project the existing directory so previously persisted metadata works too. */
  private catalog() {
    return `WITH
        splitByChar('.', symbol)[2] AS instrumentId,
        splitByChar('.', symbol)[1] AS exchangeId,
        extract(instrumentId, '^([A-Za-z]+)[0-9]') AS contractFamily,
        JSONExtractString(metadata, 'underlying') AS underlyingSymbol,
        JSONExtractString(metadata, 'product') AS declaredProduct,
        multiIf(contractFamily != '', contractFamily,
          kind = 'option' AND match(underlyingSymbol, '^[A-Za-z]+[.][0-9]+$'),
            splitByChar('.', underlyingSymbol)[2],
          match(declaredProduct, '^[A-Za-z0-9_]+$'), declaredProduct, '') AS family
      SELECT symbol, concat(exchangeId, '.', upper(family)) AS productKey,
        JSONExtractString(metadata, 'name') AS name, toBool(JSONExtractBool(metadata, 'expired')) AS expired,
        JSONExtractString(metadata, 'kind') AS kind
      FROM ${this.table('quant_instruments')} FINAL
      WHERE engine = {engine:String} AND kind IN ('future','option') AND family != ''`;
  }

  private selections() {
    return this.table('quant_product_sync_selections');
  }

  private progress() {
    return this.table('quant_product_sync_progress');
  }

  private saved() {
    return `SELECT symbol FROM ${this.progress()} FINAL
      WHERE engine = {engine:String} AND lastBarAt > 0`;
  }

  async overview(engine: Engine, userId: string): Promise<ProductSyncOverview> {
    const ownSelections = `SELECT target, productKey, isContract FROM ${this.selections()} FINAL
       WHERE engine = {engine:String} AND userId = {userId:String} AND selected`;
    const params = { engine, userId };
    const [selections, rows] = await Promise.all([
      this.rows<SelectionCounts>(
        `SELECT productKey, toBool(countIf(NOT isContract) > 0) AS selected,
           toUInt32(countIf(isContract)) AS selectedContracts
         FROM (${ownSelections}) GROUP BY productKey`,
        params,
      ),
      this.rows<ProductCounts>(
        `SELECT productKey, toUInt32(count()) AS total,
         toUInt32(countIf(hasData)) AS ready, toUInt32(countIf(isDirect)) AS directMatched,
         toUInt32(countIf(isDirect AND hasData)) AS directReady
       FROM (SELECT productKey,
         symbol IN (SELECT target FROM (${ownSelections}) WHERE isContract) AS isDirect,
         symbol IN (${this.saved()}) AS hasData
         FROM (${this.catalog()}) WHERE NOT expired)
       GROUP BY productKey`,
        params,
      ),
    ]);
    const options = new Map<string, ProductSyncOption>();
    const optionFor = (key: string) => {
      let option = options.get(key);
      if (!option) {
        option = {
          key,
          selected: false,
          selectedContracts: 0,
          ready: 0,
          total: 0,
        };
        options.set(key, option);
      }
      return option;
    };
    let selectedContracts = 0;
    for (const row of selections) {
      const option = optionFor(row.productKey);
      option.selected = row.selected;
      option.selectedContracts = row.selectedContracts;
      selectedContracts += row.selectedContracts;
    }
    let matched = 0;
    let ready = 0;
    for (const row of rows) {
      const option = optionFor(row.productKey);
      option.total = row.total;
      option.ready = row.ready;
      matched += option.selected ? row.total : row.directMatched;
      ready += option.selected ? row.ready : row.directReady;
    }
    return {
      options: [...options.values()].sort((a, b) => a.key.localeCompare(b.key)),
      matched,
      ready,
      selectedContracts,
    };
  }

  async contracts(
    engine: Engine,
    userId: string,
    productKey: string,
    query = '',
    cursor = '',
  ): Promise<ProductSyncContractPage> {
    const rows = await this.rows<ProductSyncContract>(
      `SELECT c.symbol AS symbol, c.name AS name, c.expired AS expired,
         toBool(c.symbol IN (SELECT target FROM ${this.selections()} FINAL WHERE engine = {engine:String}
           AND userId = {userId:String} AND productKey = {productKey:String} AND isContract AND selected)) AS selected,
         toBool(p.lastBarAt > 0) AS ready, p.firstBarAt AS firstBarAt, p.lastBarAt AS lastBarAt, p.outcome AS outcome
       FROM (${this.catalog()}) AS c
       LEFT JOIN (SELECT symbol, firstBarAt, lastBarAt, outcome FROM ${this.progress()} FINAL
         WHERE engine = {engine:String}) AS p ON p.symbol = c.symbol
       WHERE c.productKey = {productKey:String} AND (NOT c.expired OR selected)
         AND c.symbol > {cursor:String} AND (positionCaseInsensitiveUTF8(c.symbol,{query:String}) > 0
           OR positionCaseInsensitiveUTF8(c.name,{query:String}) > 0)
       ORDER BY c.symbol LIMIT ${contractPageSize + 1} SETTINGS join_use_nulls = 0`,
      { engine, userId, productKey, cursor, query: query.trim() },
    );
    const items = rows
      .slice(0, contractPageSize)
      .map(({ firstBarAt, lastBarAt, outcome, ...contract }) => ({
        ...contract,
        ...(firstBarAt ? { firstBarAt } : {}),
        ...(lastBarAt ? { lastBarAt } : {}),
        ...(outcome ? { outcome } : {}),
      }));
    return {
      items,
      nextCursor: rows.length > contractPageSize ? items.at(-1)!.symbol : null,
    };
  }

  async setSelected(
    engine: Engine,
    userId: string,
    key: string,
    selected: boolean,
  ) {
    // Scope both the validation and write to one query so disabling an expired
    // selection works without permitting synthetic or wildcard subscriptions.
    if (!/^[A-Za-z0-9]+[.][A-Za-z0-9_.-]+$/.test(key)) return false;
    const source = selected
      ? `SELECT productKey, symbol = {key:String} AS isContract FROM (${this.catalog()})
         WHERE NOT expired AND (productKey = {key:String} OR symbol = {key:String})
         ORDER BY isContract DESC LIMIT 1`
      : `SELECT productKey, isContract FROM ${this.selections()} FINAL
         WHERE engine = {engine:String} AND userId = {userId:String} AND target = {key:String}`;
    const result = await this.execute(
      `INSERT INTO ${this.selections()}
       SELECT {engine:String}, {userId:String}, {key:String}, productKey, isContract, {selected:Bool}, ${versionSql}
       FROM (${source})`,
      { engine, userId, key, selected: String(selected) },
      undefined,
      `product-selection:${engine}:${userId}:${key}`,
    );
    return result.writtenRows > 0;
  }

  async due(engine: Engine, limit: number): Promise<ProductSyncTarget[]> {
    const selected = `SELECT target FROM ${this.selections()} FINAL
      WHERE engine = {engine:String} AND selected`;
    if (!(await this.rows(`${selected} LIMIT 1`, { engine })).length) return [];
    return this.rows<ProductSyncTarget>(
      `SELECT c.symbol AS symbol, p.latest AS latest
       FROM (SELECT symbol FROM (${this.catalog()}) WHERE NOT expired
         AND (symbol IN (${selected} AND isContract) OR productKey IN (${selected} AND NOT isContract))) AS c
       LEFT JOIN (SELECT symbol, latest, nextCheckAt FROM ${this.progress()} FINAL
         WHERE engine = {engine:String}) AS p ON p.symbol = c.symbol
       WHERE p.nextCheckAt <= ${timeSql}
       ORDER BY p.nextCheckAt, c.symbol LIMIT {limit:UInt32}
       SETTINGS join_use_nulls = 0`,
      { engine, limit: String(limit) },
    );
  }

  async record(engine: Engine, ownerId: string, results: ProductSyncResult[]) {
    if (!results.length) return;
    const symbols = results.map((row) => row.symbol);
    const result = await this.execute(
      `INSERT INTO ${this.progress()}
       SELECT {engine:String}, r.symbol, mapUpdate(p.latest,
         mapFromArrays(mapKeys(r.latest),
           arrayMap(k -> greatest(p.latest[k], r.latest[k]), mapKeys(r.latest)))),
         if(p.firstBarAt = 0 OR r.firstBarAt = 0, greatest(p.firstBarAt, r.firstBarAt),
           least(p.firstBarAt, r.firstBarAt)), greatest(p.lastBarAt, r.lastBarAt), r.outcome,
         ${timeSql} + if(r.outcome IN ('error', 'empty'), 300, 60), ${versionSql}
       FROM input('symbol String, latest Map(String, UInt32), firstBarAt UInt32, lastBarAt UInt32, outcome String') AS r
       LEFT JOIN (SELECT symbol, latest, firstBarAt, lastBarAt FROM ${this.progress()} FINAL
         WHERE engine = {engine:String} AND symbol IN (SELECT arrayJoin(JSONExtract({symbols:String}, 'Array(String)')))) AS p
         ON p.symbol = r.symbol
       WHERE EXISTS (SELECT 1 FROM ${this.table('quant_leases')} FINAL
         WHERE engine = {engine:String} AND ownerId = {ownerId:String} AND expiresAt > ${timeSql})
       SETTINGS join_use_nulls = 0 FORMAT JSONEachRow`,
      { engine, ownerId, symbols: JSON.stringify(symbols) },
      results.map((row) => JSON.stringify(row)).join('\n'),
      `collector:${engine}`,
    );
    if (!result.writtenRows) throw new Error('WRITER_LEASE_LOST');
  }
}
