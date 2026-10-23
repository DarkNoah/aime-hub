import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type {
  BacktestResult,
  BacktestRun,
  StrategyDetail,
  StrategyVersion,
} from '../strategy-types.js';
import { backtestSchema } from '../server/strategies/schema.js';
import { runPython } from '../server/strategies/runner.js';
import { collectSnapshot } from '../server/strategies/snapshot.js';
import { ClickHouseError } from '../server/clickhouse-client.js';
import { tradeCandleTime, tradeMarkers } from '../web/trade-markers.js';
import {
  actual,
  commodity,
  input,
  start,
  stock,
  strategyFixture,
} from './strategy-fixture.js';

async function waitRun(
  f: Awaited<ReturnType<typeof strategyFixture>>,
  id: string,
) {
  for (let i = 0; i < 300; i++) {
    const run = await f.records.run('alice', id);
    if (!['queued', 'preparing', 'running'].includes(run.status)) return run;
    await delay(100);
  }
  throw new Error('Runner did not finish');
}
test('backtest inputs reject invalid chronology, unsafe values and malformed script references', () => {
  const config = input(randomUUID());
  assert.ok(backtestSchema.safeParse(config).success);
  assert.ok(
    backtestSchema.safeParse({
      ...config,
      start: Date.parse('2022-07-22T09:30:00+08:00') / 1000,
      execution_model: 'continuous_price',
    }).success,
  );
  for (const changed of [
    { ...config, end: config.start },
    { ...config, symbol: '../secret' },
    { ...config, version_id: 'missing' },
    { ...config, initial_cash: -1 },
    { ...config, duration: 2592000 },
    { ...config, start: config.end - 3661 * 86400 },
    { ...config, execution_model: 'unknown' },
    { ...config, symbol: actual, execution_model: 'continuous_price' },
    { ...config, end: Date.now() / 1000 + 3600 },
    { ...config, rules: { ...config.rules, margin_rate: 2 } },
  ])
    assert.equal(backtestSchema.safeParse(changed).success, false);
});
test('explicit continuous-price snapshots paginate main bars without inventing contract mappings', async () => {
  const config = {
    ...input(randomUUID()),
    execution_model: 'continuous_price' as const,
  };
  config.end = start + 70 * 86400;
  const source = Array.from({ length: 1005 }, (_, i) => ({
    symbol: config.symbol,
    duration: 60,
    time: start + (i === 1004 ? 60 * 86400 : i * 60),
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 100,
  }));
  let pages = 0;
  let attempts = 0;
  const store = {
    table: () => 'quotes',
    rows: async () => [],
    bars: async (
      _engine: string,
      symbol: string,
      duration: number,
      page: {
        after: number;
        before: number;
        limit: number;
        singleThread: boolean;
        rebuildTicks: boolean;
      },
    ) => {
      pages++;
      assert.equal(symbol, config.symbol);
      assert.equal(duration, 60);
      assert.equal(page.singleThread, true);
      assert.equal(page.rebuildTicks, false);
      assert.ok(page.before - page.after <= 31 * 86400 + 1);
      if (attempts++ < 2) {
        pages--;
        throw attempts === 1
          ? new ClickHouseError(500, 241)
          : new DOMException('Read timed out', 'TimeoutError');
      }
      return source
        .filter((bar) => bar.time > page.after && bar.time < page.before)
        .slice(0, page.limit);
    },
  } as unknown as Parameters<typeof collectSnapshot>[0];
  const state = {
    instrument: async () => ({
      symbol: config.symbol,
      kind: 'continuous',
      priceTick: 0.2,
    }),
  } as unknown as Parameters<typeof collectSnapshot>[1];
  const raw = await collectSnapshot(
    store,
    state,
    'tqsdk',
    config,
    new AbortController().signal,
  );
  assert.equal(pages, 4); // two pages in October, empty November, sparse December
  assert.deepEqual(raw.bars, source);
  assert.deepEqual(raw.mappings, {});
  assert.equal(raw.instruments[config.symbol].kind, 'continuous');
  await assert.rejects(
    collectSnapshot(
      store,
      state,
      'tqsdk',
      { ...config, execution_model: 'actual_contract' },
      new AbortController().signal,
    ),
    /缺少起始时点的历史主力映射/,
  );
});
test('trade markers use candle close labels, preserve same-bar exits and omit offscreen points', () => {
  const trade = {
    id: 'trade',
    symbol: actual,
    side: 'long' as const,
    quantity: 1,
    entry_time: start,
    exit_time: start + 60,
    entry_price: 100,
    exit_price: 110,
    gross_pnl: 10,
    fees: 1,
    net_pnl: 9,
    entry_signal_id: null,
    exit_signal_id: null,
  };
  const bars = [start, start + 60].map((time) => ({
    symbol: actual,
    duration: 60,
    time,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1,
  }));
  assert.deepEqual(
    tradeMarkers(trade, bars, 60).map((marker) => marker.time),
    [start + 60, start + 120],
  );
  assert.equal(
    tradeMarkers({ ...trade, entry_time: start - 60 }, bars, 60).length,
    1,
  );
  assert.equal(
    tradeMarkers({ ...trade, exit_time: start }, bars, 60).length,
    2,
  );
});
test('Python process cancellation kills uncooperative code and does not inherit host secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quant-process-'));
  const secret = process.env.QUANT_PRIVATE_TEST;
  process.env.QUANT_PRIVATE_TEST = 'must-not-leak';
  try {
    const script = join(dir, 'check.py');
    await writeFile(
      script,
      "import os\nassert 'QUANT_PRIVATE_TEST' not in os.environ\n",
    );
    await runPython('python3', [script], dir, new AbortController().signal);
    await writeFile(
      script,
      'import signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)\n',
    );
    const now = Date.now();
    await assert.rejects(
      runPython('python3', [script], dir, AbortSignal.timeout(200)),
      /用户中止/,
    );
    assert.ok(Date.now() - now < 4000);
  } finally {
    if (secret === undefined) delete process.env.QUANT_PRIVATE_TEST;
    else process.env.QUANT_PRIVATE_TEST = secret;
    await rm(dir, { recursive: true, force: true });
  }
});
test('trade markers follow market candle intervals when changing periods, including night sessions', () => {
  const base = {
    symbol: actual,
    duration: 300,
    time: start,
    open: 100,
    close: 100,
    high: 110,
    low: 90,
    volume: 1,
  };
  assert.equal(tradeCandleTime(start + 120, [base], 300), start);
  assert.equal(tradeCandleTime(start + 300, [base], 300), null);
  assert.equal(tradeCandleTime(start - 1, [base], 300), null);
  const friday = Date.parse('2026-10-16T21:00:00+08:00') / 1000;
  const mondayNight = Date.parse('2026-10-19T21:00:00+08:00') / 1000;
  const mondayDay = Date.parse('2026-10-19T14:00:00+08:00') / 1000;
  assert.equal(
    tradeCandleTime(
      mondayDay,
      [
        { ...base, time: friday },
        { ...base, time: mondayNight },
      ],
      86400,
    ),
    friday,
  );
  const month = Date.parse('2026-02-01T00:00:00+08:00') / 1000;
  const nextMonth = Date.parse('2026-03-01T00:00:00+08:00') / 1000;
  assert.equal(
    tradeCandleTime(nextMonth - 1, [{ ...base, time: month }], 2592000),
    month,
  );
  assert.equal(
    tradeCandleTime(nextMonth, [{ ...base, time: month }], 2592000),
    null,
  );
});
test(
  'real ClickHouse + plugin venv: immutable versions, ownership, backtest, frozen replay, cancellation and failure',
  { skip: process.env.QUANT_STRATEGY_INTEGRATION !== '1', timeout: 120000 },
  async () => {
    const f = await strategyFixture();
    try {
      assert.equal((await f.request('/strategies/not-a-uuid')).status, 404);
      assert.equal(
        (await f.request('/strategies/runs/not-a-uuid/result')).status,
        404,
      );
      const template = await readFile(
        'plugins/vibe-quant/sdk/examples/strategy.py',
        'utf8',
      );
      const source = template.replace(
        "ctx.data.subscribe(ctx.params['symbol'], ctx.params.get('duration', 60))",
        "ctx.data.subscribe(ctx.params['symbol'], ctx.params.get('duration', 60))\n        import sys\n        ctx.log('python_runtime', prefix=sys.prefix)",
      );
      const body = {
        name: 'IM 均线回测',
        description: '',
        enabled: true,
        draft: {
          source,
          parameters: { fast: 2, slow: 4 },
        },
      };
      const response = await f.request('/strategies', 'POST', body);
      assert.equal(response.status, 201);
      const strategy = (await response.json()) as StrategyDetail;
      assert.equal(
        (
          await f.request(`/strategies/${strategy.id}`, 'GET', undefined, {
            'x-user': 'bob',
          })
        ).status,
        404,
      );
      const versionResponse = await f.request(
        `/strategies/${strategy.id}/versions`,
        'POST',
        { revision: strategy.revision, note: '基线' },
      );
      const published = (await versionResponse.json()) as {
        strategy: StrategyDetail;
        version: StrategyVersion;
      };
      assert.equal(versionResponse.status, 201);
      assert.equal(
        (
          await f.request(`/strategies/${strategy.id}`, 'PUT', {
            ...body,
            revision: strategy.revision,
          })
        ).status,
        409,
      );
      const updated = await f.records.save(
        'alice',
        {
          ...body,
          draft: { ...body.draft, source: source + '\n# next revision\n' },
        },
        strategy.id,
        published.strategy.revision,
      );
      assert.notEqual(
        updated.draft.source,
        (await f.records.version('alice', published.version.id)).source,
      );
      const config = input(published.version.id);
      assert.equal(
        (
          await f.request(`/strategies/${strategy.id}/runs`, 'POST', config, {
            'x-admin': 'false',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await f.request(`/strategies/${strategy.id}/runs`, 'POST', config, {
            'x-user': 'bob',
          })
        ).status,
        404,
      );
      const created = await f.request(
        `/strategies/${strategy.id}/runs`,
        'POST',
        config,
      );
      assert.equal(created.status, 202);
      const run = (await created.json()) as BacktestRun;
      f.worker.start();
      const finished = await waitRun(f, run.id);
      assert.equal(finished.status, 'completed', finished.message);
      assert.equal(finished.source_hash, published.version.source_hash);
      const result = JSON.parse(
        (await f.records.artifact(run.id, 'result'))!.text,
      ) as BacktestResult;
      assert.ok(result.trades.length > 1);
      assert.ok(result.risk_levels!.length > result.trades.length);
      assert.ok(
        result.risk_levels!.some(
          (level) => level.entry_signal_id === result.trades[0].entry_signal_id,
        ),
      );
      assert.ok(result.trades.every((t) => t.symbol.startsWith('CFFEX.IM')));
      assert.ok(
        result.logs.some((log) =>
          JSON.stringify(log).includes('plugins/vibe-quant/.venv'),
        ),
      );
      const replayPath = `/strategies/runs/${run.id}/trades/${result.trades[0].id}/replay`;
      const chartPath = replayPath.replace('/replay', '/bars');
      const candle = {
        symbol: result.trades[0].symbol,
        duration: 60,
        open: 100,
        high: 110,
        low: 90,
        close: 100,
        volume: 1,
      };
      // Add history beyond both ends of the frozen run. Chart pagination must still reach it.
      f.addMarketBars(
        Array.from({ length: 500 }, (_, index) => ({
          ...candle,
          time: start - (500 - index) * 60,
        })),
      );
      f.addMarketBars(
        Array.from({ length: 500 }, (_, index) => ({
          ...candle,
          time: config.end + index * 60,
        })),
      );
      const chart = await (
        await f.request(
          `${chartPath}?duration=60&around=${result.trades[0].entry_time}`,
        )
      ).json();
      assert.equal(chart.bars.length, 201);
      assert.equal(chart.bars[100].time, result.trades[0].entry_time);
      assert.equal(
        chart.priceTick,
        f.instruments.find((item) => item.symbol === candle.symbol)!.priceTick,
      );
      const older = await (
        await f.request(`${chartPath}?duration=60&before=${start}&limit=200`)
      ).json();
      const newer = await (
        await f.request(
          `${chartPath}?duration=60&after=${config.end}&limit=200`,
        )
      ).json();
      const more = await (
        await f.request(
          `${chartPath}?duration=60&after=${newer.at(-1).time}&limit=200`,
        )
      ).json();
      assert.equal(older.length, 200);
      assert.equal(newer.length, 200);
      assert.equal(more.length, 200);
      assert.ok(
        older.every((bar: { time: number }) => bar.time < config.start),
      );
      assert.ok(newer.every((bar: { time: number }) => bar.time > config.end));
      assert.ok(more[0].time > newer.at(-1).time);
      assert.equal(
        (await f.request(chartPath, 'GET', undefined, { 'x-user': 'bob' }))
          .status,
        404,
      );
      assert.equal(
        (
          await f.request(
            `${chartPath}?duration=60&before=${start}&after=${start}`,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await f.request(
            chartPath.replace(result.trades[0].id, 'unknown-trade'),
          )
        ).status,
        404,
      );
      const replay = await (await f.request(replayPath)).json();
      const grouped = await (
        await f.request(`${replayPath}?duration=300&at=exit`)
      ).json();
      assert.equal(grouped.duration, 300);
      assert.ok(grouped.bars.length < replay.bars.length);
      assert.ok(
        grouped.markerTimes.entry !== null && grouped.markerTimes.exit !== null,
      );
      assert.equal((await f.request(`${replayPath}?duration=7`)).status, 400);
      assert.equal(
        (await f.request(`${replayPath}?before=${start}&after=${start}`))
          .status,
        400,
      );
      f.mutateMarket(1000);
      assert.deepEqual(
        await (await f.request(replayPath)).json(),
        replay,
        'replay must use frozen data',
      );
      assert.deepEqual(
        await (await f.request(`${replayPath}?duration=300&at=exit`)).json(),
        grouped,
      );
      assert.equal(
        (await f.request(replayPath, 'GET', undefined, { 'x-user': 'bob' }))
          .status,
        404,
      );
      const exported = await (
        await f.request(`/strategies/runs/${run.id}/export`)
      ).json();
      assert.equal(exported.version.source, source);
      assert.ok(exported.dataset.events.length);
      assert.equal(
        exported.manifest.source_hash,
        published.version.source_hash,
      );
      f.mutateMarket(0);
      for (const symbol of [commodity, stock]) {
        const next = await f.records.enqueue(
          'alice',
          strategy.id,
          input(published.version.id, symbol),
          'tqsdk',
        );
        f.worker.wake();
        const done = await waitRun(f, next.id);
        assert.equal(done.status, 'completed', done.message);
      }
      const benchmarkConfig = {
        ...config,
        benchmark_symbol: 'SSE.000300',
        calendar: undefined,
      };
      const benchmarkRun = await f.records.enqueue(
        'alice',
        strategy.id,
        benchmarkConfig,
        'tqsdk',
      );
      f.worker.wake();
      const benchmarkDone = await waitRun(f, benchmarkRun.id);
      assert.equal(benchmarkDone.status, 'completed', benchmarkDone.message);
      const benchmarkResult = JSON.parse(
        (await f.records.artifact(benchmarkRun.id, 'result'))!.text,
      );
      assert.notEqual(benchmarkResult.metrics.benchmark_return, null);
      assert.ok(
        benchmarkResult.trades.every(
          (trade: { symbol: string }) => trade.symbol !== 'SSE.000300',
        ),
      );
      await f.worker.stop();
      const queued = await f.records.enqueue(
        'alice',
        strategy.id,
        config,
        'tqsdk',
      );
      const cancelled = await f.records.cancel('alice', queued.id);
      assert.equal(cancelled.status, 'cancelled');
      const infinite = await f.records.save(
        'alice',
        {
          ...body,
          draft: {
            ...body.draft,
            source: 'import time\nwhile True: time.sleep(1)\n',
          },
        },
        strategy.id,
        updated.revision,
      );
      const badVersion = await f.records.publish(
        'alice',
        strategy.id,
        infinite.revision,
        'cancel fixture',
      );
      const pending = await f.records.enqueue(
        'alice',
        strategy.id,
        input(badVersion.version.id),
        'tqsdk',
      );
      f.worker.start();
      for (
        let i = 0;
        i < 80 &&
        (await f.records.run('alice', pending.id)).status !== 'running';
        i++
      )
        await delay(100);
      await f.records.cancel('alice', pending.id);
      assert.equal((await waitRun(f, pending.id)).status, 'cancelled');
      f.missingMapping();
      await assert.rejects(
        collectSnapshot(
          f.market,
          f.state,
          'tqsdk',
          config,
          new AbortController().signal,
        ),
        /历史主力映射/,
      );
      const failed = await f.records.enqueue(
        'alice',
        strategy.id,
        config,
        'tqsdk',
      );
      f.worker.wake();
      assert.equal((await waitRun(f, failed.id)).status, 'failed');
      assert.ok((await f.records.runs('alice', strategy.id)).length >= 6);
      const old = await f.records.enqueue(
        'alice',
        strategy.id,
        config,
        'tqsdk',
      );
      await f.worker.stop();
      await f.records.request(
        `INSERT INTO ${f.records.table('quant_strategy_runs')}
         SELECT id, userId, JSONMergePatch(payload, {patch:String}), revision + 1
         FROM ${f.records.table('quant_strategy_runs')} FINAL WHERE id = {id:String}`,
        {
          id: old.id,
          patch: JSON.stringify({
            status: 'running',
            heartbeat_at: new Date(Date.now() - 100_000).toISOString(),
          }),
        },
      );
      await f.records.claim(randomUUID());
      assert.equal((await f.records.run('alice', old.id)).status, 'failed');
      const all = await f.records.runs('alice', strategy.id);
      const page = await f.records.runs('alice', strategy.id, all[1].id);
      assert.ok(!page.some((r) => r.id === all[0].id || r.id === all[1].id));
    } finally {
      await f.close();
    }
  },
);

test(
  'real ClickHouse snapshot retains point-in-time main-contract changes and all execution bars',
  {
    skip:
      process.env.QUANT_INTEGRATION !== '1' ||
      process.env.QUANT_STRATEGY_INTEGRATION !== '1',
    timeout: 60000,
  },
  async () => {
    const { MarketStore } = await import('../server/clickhouse.js');
    const f = await strategyFixture();
    const store = new MarketStore({
      ...f.config,
      clickhouseDatabase: `snapshot_${randomUUID().replaceAll('-', '')}`,
      clickhousePassword: 'test-only-local',
    });
    try {
      await store.request(
        `CREATE DATABASE IF NOT EXISTS ${store.table('bars').split('.')[0]}`,
      );
      await store.initialize();
      const bars = (
        await Promise.all(
          f.instruments.map((item) =>
            f.market.bars('tqsdk', item.symbol, 60, {
              after: start - 1,
              before: start + 7200,
              limit: 1000,
            }),
          ),
        )
      ).flat();
      const quote = {
        symbol: 'KQ.m@CFFEX.IM',
        time: start - 1,
        underlying: actual,
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
      };
      await store.write(
        'tqsdk',
        [
          quote,
          { ...quote, time: start + 60 },
          { ...quote, time: start + 3600, underlying: 'CFFEX.IM2612' },
          { ...quote, time: start + 3660, underlying: 'CFFEX.IM2612' },
        ],
        bars,
      );
      const snapshot = await collectSnapshot(
        store,
        f.state,
        'tqsdk',
        input(randomUUID()),
        new AbortController().signal,
      );
      assert.equal(snapshot.bars.length, 360);
      assert.deepEqual(
        snapshot.mappings['KQ.m@CFFEX.IM'].map((item) => item.underlying),
        [actual, actual, 'CFFEX.IM2612'],
      );
      assert.equal(
        snapshot.mappings['KQ.m@CFFEX.IM'].at(-1)!.time,
        start + 3600,
      );
    } finally {
      await store.request(
        `DROP DATABASE IF EXISTS ${store.table('bars').split('.')[0]}`,
      );
      await f.close();
    }
  },
);
