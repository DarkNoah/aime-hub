import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import type { PluginContext } from '@app/plugin-sdk/server';
import { MarketBarsTool } from '../mastra/tools/market-bars.js';
import type { QuantDependencies } from '../mastra/tools/context.js';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { MONTH_DURATION, type Bar } from '../shared.js';

const timestamp = (date: string) => Date.parse(`${date}+08:00`) / 1000;
const config = {
  engine: 'tdx',
  clickhouseUrl: 'http://127.0.0.1:8123',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'reader',
  clickhousePassword: 'fixture',
  tdxServers: '127.0.0.1:7709',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 100,
};
const bar = (date: string, values: Partial<Bar> = {}): Bar => ({
  symbol: 'SSE.000852',
  duration: 60,
  time: timestamp(date),
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100,
  ...values,
});

async function fixture(market: QuantDependencies['market']) {
  let allowed = true;
  const context = {
    assertEnabled: async () => {
      if (!allowed) throw new Error('disabled');
    },
    database: { query: async () => [{ role: 'user', banned: false }] },
  } as unknown as PluginContext;
  const deps = { market, config: { engine: 'tdx' } } as QuantDependencies;
  const [tool] = await new MarketBarsTool(context, () => deps).getTools();
  assert.ok('execute' in tool && tool.execute);
  return {
    disable: () => {
      allowed = false;
    },
    call: (input: object = {}, signal?: AbortSignal, user = 'reader') => {
      const requestContext = new RequestContext();
      if (user) requestContext.set('userId', user);
      return tool.execute!(
        { symbol: 'SSE.000852', ...input },
        {
          requestContext,
          abortSignal: signal,
          observe: noopObserve,
        },
      );
    },
  };
}

test('date filtering precedes pagination in both directions, including read-only live overlays', async (t) => {
  const source = [
    bar('2026-10-18T23:59:00'),
    ...Array.from({ length: 7 }, (_, i) => bar(`2026-10-19T09:3${i}:00`)),
    bar('2026-10-20T00:00:00'),
    bar('2026-10-19T09:30:00', { symbol: 'OTHER' }),
    bar('2026-10-19T09:30:00', { duration: 300 }),
  ];
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const p = new URL(String(input)).searchParams;
    const asc = p.get('query')!.includes('ORDER BY time ASC');
    return Response.json({
      data: source
        .filter(
          (b) =>
            p.get('param_engine') === 'tdx' &&
            b.symbol === p.get('param_symbol') &&
            b.duration === Number(p.get('param_duration')) &&
            b.time < Number(p.get('param_before')) &&
            (!p.has('param_after') || b.time > Number(p.get('param_after'))),
        )
        .sort((a, b) => (asc ? a.time - b.time : b.time - a.time))
        .slice(0, Number(p.get('param_limit'))),
    });
  });
  for (const clickhouseReadOnly of [false, true]) {
    const store = new MarketStore(
      parseConfig({ ...config, clickhouseReadOnly }),
    );
    if (clickhouseReadOnly)
      await store.write(
        'tdx',
        [],
        [
          { ...source[1], close: 12 },
          bar('2026-10-19T09:37:00'),
          bar('2026-10-20T00:01:00'),
        ],
      );
    const f = await fixture(store);
    for (const order of ['asc', 'desc']) {
      const times: number[] = [];
      let cursor: number | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await f.call({
          start_date: '2026-10-19',
          order,
          limit: 2,
          cursor,
        });
        assert.equal(page.timezone, 'Asia/Shanghai');
        assert.equal(page.end_date, '2026-10-19');
        assert.ok(
          page.bars.every(
            (b: Bar) => b.symbol === 'SSE.000852' && b.duration === 60,
          ),
        );
        times.push(...page.bars.map((b: Bar) => b.time));
        if (!page.has_more) {
          assert.equal(page.next_cursor, null);
          break;
        }
        assert.equal(page.next_cursor, page.bars.at(-1).time);
        cursor = page.next_cursor;
      }
      const expected = source.slice(1, 8).map((b) => b.time);
      if (clickhouseReadOnly) expected.push(timestamp('2026-10-19T09:37:00'));
      if (order === 'desc') expected.reverse();
      assert.deepEqual(times, expected);
    }
    const empty = await f.call({ start_date: '2026-10-21' });
    assert.deepEqual(empty.bars, []);
    assert.equal(empty.next_cursor, null);
  }
});

test('derived periods keep full candles and exclusive cursors within the requested dates', async (t) => {
  const source = [
    ...Array.from({ length: 9 }, (_, i) => bar(`2026-10-19T09:3${i}:00`)),
    bar('2026-01-02T00:00:00', { duration: 86400 }),
    bar('2026-01-30T00:00:00', { duration: 86400, close: 12 }),
    bar('2026-02-02T00:00:00', { duration: 86400 }),
    bar('2026-02-27T00:00:00', { duration: 86400, close: 13 }),
  ];
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const p = new URL(String(input)).searchParams;
    const asc = p.get('query')!.includes('ORDER BY time ASC');
    return Response.json({
      data: source
        .filter(
          (b) =>
            b.duration === Number(p.get('param_duration')) &&
            b.time < Number(p.get('param_before')) &&
            (!p.has('param_after') || b.time > Number(p.get('param_after'))),
        )
        .sort((a, b) => (asc ? a.time - b.time : b.time - a.time))
        .slice(0, Number(p.get('param_limit'))),
    });
  });
  const f = await fixture(new MarketStore(parseConfig(config)));
  for (const order of ['asc', 'desc']) {
    const query = { duration: 180, start_date: '2026-10-19', limit: 2, order };
    const first = await f.call(query);
    const second = await f.call({ ...query, cursor: first.next_cursor });
    const bars = [...first.bars, ...second.bars];
    assert.equal(new Set(bars.map((b: Bar) => b.time)).size, 3);
    assert.ok(bars.every((b: Bar) => b.volume === 300));
    assert.equal(second.has_more, false);
    const monthly = {
      duration: MONTH_DURATION,
      start_date: '2026-01-01',
      end_date: '2026-02-10',
      order,
      limit: 1,
    };
    const one = await f.call(monthly);
    const two = await f.call({ ...monthly, cursor: one.next_cursor });
    assert.equal(one.has_more, true);
    assert.equal(two.has_more, false);
    assert.notEqual(one.bars[0].time, two.bars[0].time);
    assert.equal(one.bars[0].volume, 200);
    assert.equal(two.bars[0].volume, 200);
  }
});

test('invalid input, authentication and plugin state stop reads; abort returns immediately', async () => {
  let reads = 0;
  let reading!: () => void;
  const ready = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let release!: (bars: Bar[]) => void;
  const f = await fixture({
    bars: async () => {
      reads++;
      reading();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  for (const input of [
    { start_date: '2026-02-30' },
    { start_date: '2026-10-20', end_date: '2026-10-19' },
    { duration: 120 },
    { limit: 501 },
    { limit: 0 },
    { cursor: -1 },
    { symbol: 'x; DROP TABLE bars' },
  ])
    assert.equal((await f.call(input)).error, 'INVALID_ARGUMENTS');
  assert.equal((await f.call({}, undefined, '')).error, 'UNAUTHORIZED');
  assert.equal(reads, 0);
  const controller = new AbortController();
  const pending = f.call({}, controller.signal);
  await ready;
  controller.abort();
  assert.deepEqual(await pending, {
    cancelled: true,
    message: '用户中止了操作',
  });
  release([]);
  f.disable();
  assert.equal((await f.call({})).error, 'QUANT_SERVICE_UNAVAILABLE');
  assert.equal(reads, 1);
});
