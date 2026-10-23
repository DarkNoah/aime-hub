import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { Instrument, Quote, SyncStatus } from '../shared.js';
import { StrategyFeed } from '../server/sdk/feed.js';
import { strategyDataRoutes } from '../server/sdk/routes.js';
import { StrategySubscriptions } from '../server/sdk/subscriptions.js';
import { StateStore } from '../server/state-store.js';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const main = 'KQ.m@CFFEX.IM';
const actual = 'CFFEX.IM2611';
const quote = (symbol: string, underlying = ''): Quote => ({
  symbol,
  underlying,
  time: 100,
  last: 8000,
  preClose: null,
  open: null,
  high: null,
  low: null,
  volume: null,
  amount: null,
  openInterest: null,
  bid: null,
  ask: null,
});
const instrument = (symbol: string): Instrument => ({
  symbol,
  name: symbol,
  kind: symbol === main ? 'continuous' : 'future',
  exchange: 'CFFEX',
  product: 'IM',
  priceTick: 0.2,
  underlying: '',
  expired: false,
});
const config = parseConfig({
  engine: 'tqsdk',
  tqUser: 'fixture',
  tqPassword: 'fixture',
  clickhouseUrl: 'http://127.0.0.1:18124',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'test',
  clickhousePassword: 'test-only-local',
  maxSubscriptions: 2,
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 1,
  pollSeconds: 5,
  historyBars: 100,
});

test('bounded live feed detects evictions/restarts and filters subscribers', () => {
  const feed = new StrategyFeed(3);
  const beginning = feed.cursor;
  feed.publish({
    quotes: [quote(main, actual), quote('SHFE.rb2611')],
    bars: [],
  });
  feed.publish({ quotes: [quote(actual)], bars: [] });
  const symbols = new Set([main]);
  const page = feed.read(beginning, symbols)!;
  assert.deepEqual(
    page.batches.flatMap((b) => b.quotes.map((q) => q.symbol)),
    [main, actual],
  );
  assert.ok(symbols.has(actual));
  assert.deepEqual(feed.read(page.cursor, symbols)!.batches, []);
  feed.publish({ quotes: [quote(actual)], bars: [] });
  assert.equal(feed.read(beginning, symbols), null);
  assert.equal(new StrategyFeed().read(page.cursor, symbols), null);
  const current = feed.cursor;
  feed.publish({
    quotes: Array.from({ length: 4 }, () => quote(actual)),
    bars: [],
  });
  assert.equal(
    feed.read(current, symbols),
    null,
    'oversized batches fail explicitly instead of growing memory',
  );
});

test('SDK routes isolate owners, retain actual contracts and expose explicit gaps', async () => {
  let feed = new StrategyFeed();
  const retained: string[][] = [];
  let phase = 'syncing';
  const routes = strategyDataRoutes(() => ({
    config,
    feed,
    status: () => ({ state: phase }) as SyncStatus,
    state: {
      instrument: async (_engine: string, symbol: string) => instrument(symbol),
    } as StateStore,
    store: {
      quotes: async () => [quote(main, actual)],
    } as unknown as MarketStore,
    subscriptions: {
      retain: async (_owner: string, _id: string, symbols: string[]) => {
        retained.push(symbols);
        return true;
      },
      release: async () => {},
    } as unknown as StrategySubscriptions,
  }));
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    await next();
  });
  app.route('/sdk', routes);
  const created = await app.request('/sdk/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbols: [main] }),
  });
  assert.equal(created.status, 201);
  const session = await created.json();
  assert.deepEqual(retained[0], [main, actual]);
  assert.equal(session.initialQuotes[0].underlying, actual);
  const path = `/sdk/sessions/${session.id}/events?cursor=${session.cursor}`;
  assert.equal(
    (await app.request(path, { headers: { 'x-user': 'bob' } })).status,
    404,
  );
  feed.publish({ quotes: [quote(main, 'CFFEX.IM2612')], bars: [] });
  const page = await (await app.request(path)).json();
  assert.equal(page.batches.length, 1);
  assert.ok(retained.at(-1)!.includes('CFFEX.IM2612'));
  feed = new StrategyFeed();
  assert.equal((await (await app.request(path)).json()).code, 'SDK_EVENT_GAP');
  phase = 'standby';
  assert.equal(
    (await (await app.request(path)).json()).code,
    'CONNECT_TO_ACTIVE_COLLECTOR',
  );
  assert.equal(
    (await app.request(`/sdk/sessions/${session.id}`, { method: 'DELETE' }))
      .status,
    200,
  );
});

test('history validates requests and passes integer storage bounds', async () => {
  let bounds: unknown;
  const api = strategyDataRoutes(
    () =>
      ({
        config,
        state: {
          instrument: async () => instrument(actual),
        } as unknown as StateStore,
        store: {
          bars: async (_e: string, _s: string, _d: number, query: unknown) => {
            bounds = query;
            return [{ symbol: actual, time: 120, duration: 60 }];
          },
        } as unknown as MarketStore,
      }) as Parameters<typeof strategyDataRoutes>[0] extends () => infer D
        ? D
        : never,
  );
  assert.equal(
    (await api.request('/history?symbol=x&duration=61&after=1&before=2'))
      .status,
    400,
  );
  const response = await api.request(
    `/history?symbol=${actual}&duration=60&after=100.2&before=180.4`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(bounds, { after: 100, before: 181, limit: 1000 });
});

test(
  'SDK leases and watchlists share a real atomic ClickHouse capacity check',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async (t) => {
    const isolated = {
      ...config,
      clickhouseDatabase: `sdk_${randomUUID().replaceAll('-', '')}`,
    };
    const state = new StateStore(isolated);
    await state.request(`CREATE DATABASE ${isolated.clickhouseDatabase}`);
    t.after(() =>
      state.request(`DROP DATABASE ${isolated.clickhouseDatabase}`),
    );
    await state.initialize();
    await state.saveCatalog(
      'tqsdk',
      [main, actual, 'CFFEX.IM2612'].map(instrument),
    );
    const subscriptions = new StrategySubscriptions(isolated);
    assert.equal(
      await subscriptions.retain('alice', 'session', [main, actual]),
      true,
    );
    assert.deepEqual(await state.subscriptions('tqsdk'), [actual, main]);
    assert.equal(
      await state.setWatch('bob', 'CFFEX.IM2612', true, 'add'),
      'limit',
    );
    assert.equal(await state.setWatch('bob', actual, true, 'add'), 'ok');
    assert.equal(
      await subscriptions.retain('bob', 'other', ['CFFEX.IM2612']),
      false,
    );
    await subscriptions.release('alice', 'session');
    assert.deepEqual(await state.subscriptions('tqsdk'), [actual]);
    assert.equal(
      await subscriptions.retain('bob', 'other', ['CFFEX.IM2612']),
      true,
    );
    await subscriptions.release('bob', 'other');
    assert.deepEqual(await state.subscriptions('tqsdk'), [actual]);

    // Real HTTP -> ClickHouse -> Python SDK -> shared backtest/live kernel.
    const store = new MarketStore(isolated);
    await store.initialize();
    const start = Date.parse('2026-10-19T09:30:00+08:00') / 1000;
    const bars = [8000, 8001, 8002, 8000, 7999].flatMap((price, n) =>
      [actual, main].map((symbol) => ({
        symbol,
        duration: 60,
        time: start + n * 60,
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 1000,
      })),
    );
    await store.write(
      'tqsdk',
      [{ ...quote(main, actual), time: start - 1 }],
      bars,
    );
    const app = new Hono<PluginHttpEnv>();
    const httpFeed = new StrategyFeed();
    app.use('*', async (c, next) => {
      if (c.req.header('cookie') !== 'sdk-fixture')
        return c.json({ code: 'UNAUTHORIZED' }, 401);
      if (c.req.method !== 'GET' && c.req.header('origin') !== 'http://fixture')
        return c.json({ code: 'FORBIDDEN' }, 403);
      c.set('userId', 'python');
      await next();
    });
    app.route(
      '/sdk',
      strategyDataRoutes(() => ({
        config: isolated,
        state,
        store,
        subscriptions,
        feed: httpFeed,
        status: () => ({ state: 'syncing' }) as SyncStatus,
      })),
    );
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await app.request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const output = await mkdtemp(join(tmpdir(), 'quant-sdk-http-'));
    t.after(() => rm(output, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(
      'python3',
      [
        '-c',
        `
import json, sys
from quant_sdk import HubClient, TradingCalendar, Instrument, RunConfig, backtest, live
from test_strategy_sdk import Trend
client = HubClient(sys.argv[1], headers={'Cookie': 'sdk-fixture', 'Origin': 'http://fixture'})
calendar = TradingCalendar({'2026-10-19': True})
def rules(symbol, metadata):
    return Instrument(symbol, metadata['kind'], .2, multiplier=200, margin_rate=.12)
start = ${start}
data = client.snapshot(['${main}'], start=start, end=start+300.5, calendar=calendar, rules=rules)
params = {'symbol': '${main}'}
config = RunConfig(initial_cash=1000000)
a = backtest.run(Trend(), data, params=params, config=config, output_dir=sys.argv[2])
b = live.run(Trend(), iter(data.events), instruments=data.instruments, params=params, config=config, mode='paper', output_dir=sys.argv[2])
assert a['status'] == b['status'] == 'succeeded', (a['message'], b['message'])
assert a['signals'] == b['signals'] and a['fills'] == b['fills'] and a['metrics'] == b['metrics']
with client.stream(['${main}'], calendar=calendar, rules=rules) as source:
    assert source.session['initialQuotes'][0]['underlying'] == '${actual}'
print(json.dumps({'trades': len(a['trades']), 'events': len(data.events)}))
`,
        `http://127.0.0.1:${address.port}`,
        output,
      ],
      {
        timeout: 15000,
        env: {
          ...process.env,
          PYTHONPATH: [
            fileURLToPath(new URL('../sdk', import.meta.url)),
            fileURLToPath(new URL('.', import.meta.url)),
          ].join(delimiter),
        },
      },
    );
    assert.deepEqual(JSON.parse(stdout), { trades: 1, events: 11 });
    assert.deepEqual(
      await state.subscriptions('tqsdk'),
      [actual],
      'Python context manager releases its lease',
    );
  },
);
