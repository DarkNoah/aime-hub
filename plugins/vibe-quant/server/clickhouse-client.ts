import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { QuantConfig } from './config.js';

export const versionSql = 'toUInt64(toUnixTimestamp64Micro(now64(6)))';
export const timeSql = 'toUnixTimestamp64Milli(now64(3)) / 1000';

export class ClickHouseError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
  ) {
    super(`CLICKHOUSE_HTTP_${status}`);
  }
}

/** Identifiers come from validated config; all external values use typed parameters. */
export class ClickHouseClient {
  constructor(protected readonly config: QuantConfig) {}

  table(name: string) {
    return `\`${this.config.clickhouseDatabase}\`.${name}`;
  }

  async execute(
    query: string,
    params: Record<string, string> = {},
    body?: string,
    resource?: string,
  ) {
    const url = new URL(this.config.clickhouseUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('wait_end_of_query', '1');
    // Full-history pages and durable strategy checkpoints can be several MiB.
    // Fetch transparently decodes the negotiated HTTP response compression.
    url.searchParams.set('enable_http_compression', '1');
    // Keep concurrent chart/history reads within the shared collector's small
    // memory budget instead of expanding each request across all server CPUs.
    url.searchParams.set('max_threads', '2');
    url.searchParams.set('max_final_threads', '2');
    url.searchParams.set('max_block_size', '8192');
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(`param_${key}`, value);
    if (resource) {
      // On ClickHouse >= 24.8 query IDs are exclusive across users on one server.
      // The check and insert MUST be in the same SQL statement; this is not a
      // lock spanning multiple requests. Do not use a load-balanced endpoint.
      const key = createHash('sha256')
        .update(`${this.config.clickhouseDatabase}:${resource}`)
        .digest('hex');
      url.searchParams.set('query_id', `vibe-quant-${key}`);
      url.searchParams.set('replace_running_query', '0');
      url.searchParams.set('async_insert', '0');
      url.searchParams.set('use_query_cache', '0');
    }
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'X-ClickHouse-User': this.config.clickhouseUser,
          'X-ClickHouse-Key': this.config.clickhousePassword,
        },
        body,
      });
      if (!response.ok) {
        const code = Number(
          response.headers.get('X-ClickHouse-Exception-Code'),
        );
        await response.body?.cancel();
        if (resource && code === 216 && attempt < 99) {
          await delay(25 + Math.random() * 75);
          continue;
        }
        throw new ClickHouseError(response.status, code);
      }
      const summary = JSON.parse(
        response.headers.get('X-ClickHouse-Summary') ?? '{}',
      ) as { written_rows?: string };
      return {
        text: await response.text(),
        writtenRows: Number(summary.written_rows ?? 0),
      };
    }
  }

  async request(
    query: string,
    params: Record<string, string> = {},
    body?: string,
  ) {
    return (await this.execute(query, params, body)).text;
  }

  async rows<T>(
    query: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    return JSON.parse(await this.request(`${query} FORMAT JSON`, params)).data;
  }
}
