import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MarketStore } from '../server/clickhouse.js';
import { StateStore } from '../server/state-store.js';
import { parseConfig } from '../server/config.js';
import type { Tick } from '../shared.js';

const config = parseConfig({
  engine: 'tqsdk',
  tqUser: 'fixture',
  tqPassword: 'fixture',
  clickhouseUrl: 'http://127.0.0.1:18124',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'test',
  clickhousePassword: 'test-only-local',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 100,
});
const day = '2026-10-19';
const start = Date.parse(`${day}T09:30:00+08:00`) / 1000;
function tick(symbol: string, id: number, volume: number): Tick {
  return {
    symbol,
    tickId: String(id),
    timeNs: String(BigInt(start + id * 30) * 1_000_000_000n + 123n),
    tradingDay: day,
    receivedAt: start + 1000,
    last: 8000,
    volume,
    amount: volume * 8000 * 200,
    openInterest: 100,
    bid: 7999.8,
    bidVolume: 10,
    ask: 8000.2,
    askVolume: 20,
    volumeMultiple: 200,
    priceTick: 0.2,
    volumeUnit: 'source',
  };
}
const bar = (symbol: string, volume = 7) => ({
  symbol,
  duration: 60,
  time: start + 60,
  open: 8000,
  high: 8000,
  low: 8000,
  close: 8000,
  volume,
});

test('tick history defaults to the maximum recent window with explicit bounds', () => {
  assert.equal(config.historyTicks, 10000);
  assert.equal(parseConfig({ ...config, historyTicks: 500 }).historyTicks, 500);
  assert.throws(() => parseConfig({ ...config, historyTicks: 10001 }));
  assert.throws(() => parseConfig({ ...config, historyTicks: 0 }));
});

test('market-only mode suppresses tick writes and Tick DDL', async () => {
  const store = new MarketStore({ ...config, clickhouseReadOnly: true });
  const queries: string[] = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    queries.push(new URL(String(input)).searchParams.get('query')!);
    return new Response('');
  };
  try {
    await store.initialize();
    await store.write('tqsdk', [], [], [], undefined, [
      tick('CFFEX.IM2611', 0, 0),
    ]);
    assert.equal(queries.length, 3);
    assert.ok(
      queries.every(
        (query) => query.startsWith('SELECT ') && !query.includes('.ticks'),
      ),
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test(
  'real ClickHouse preserves tick identities, repairs gaps on backfill, and reconciles closed minutes',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async () => {
    const store = new MarketStore(config);
    await store.initialize();
    await store.initialize();
    const symbol = `TEST.${randomUUID()}`;
    const all = [0, 5, 8, 12, 14].map((volume, id) => tick(symbol, id, volume));
    const write = (ticks: Tick[]) =>
      store.write('tqsdk', [], [bar(symbol)], [], undefined, ticks);
    await write(all.filter((row) => row.tickId !== '2'));
    let check = await store.validateTickVolumes('tqsdk', symbol, day);
    assert.equal(check.rows, 4);
    assert.equal(check.sequenceGaps, 1);
    assert.equal(check.gapVolume, 7);
    assert.equal(check.observedVolume, 7);
    assert.equal(check.state, 'warning');
    await write([all[2]]);
    await write(all); // replay on process restart
    check = await store.validateTickVolumes('tqsdk', symbol, day);
    assert.equal(check.rows, 5);
    assert.equal(check.firstTimeNs, all[0].timeNs);
    assert.equal(check.lastTimeNs, all[4].timeNs);
    assert.equal(check.sequenceGaps, 0);
    assert.equal(check.observedVolume, 14);
    assert.equal(check.baselineVolume, 0);
    assert.equal(check.checkedMinutes, 1);
    assert.equal(
      check.uncheckedMinutes,
      2,
      'first baseline minute and unfinished last minute are not reconciled',
    );
    assert.equal(check.mismatchedMinutes, 0);
    assert.equal(check.state, 'consistent');
    await store.write('tqsdk', [], [bar(symbol, 99)]);
    check = await store.validateTickVolumes('tqsdk', symbol, day);
    assert.equal(check.mismatchedMinutes, 1);
    assert.equal(check.state, 'warning');
    assert.equal(
      (await store.validateTickVolumes('tdx', symbol, day)).state,
      'empty',
    );
    const collisions = `TEST.${randomUUID()}`;
    const first = tick(collisions, 10, 20);
    await store.write('tqsdk', [], [], [], undefined, [
      first,
      { ...first, tickId: '11', volume: 25 },
    ]);
    assert.equal(
      (await store.validateTickVolumes('tqsdk', collisions, day)).rows,
      2,
      'same timestamp does not collapse different SDK tick IDs',
    );
  },
);

test(
  'real ClickHouse reports partial starts and invalid cumulative data without mistaking a new day for regression',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async () => {
    const store = new MarketStore(config);
    await store.initialize();
    const symbol = `TEST.${randomUUID()}`;
    await store.write('tqsdk', [], [], [], undefined, [
      tick(symbol, 100, 1000),
      tick(symbol, 101, 1005),
    ]);
    let check = await store.validateTickVolumes('tqsdk', symbol, day);
    assert.equal(check.state, 'partial');
    assert.equal(check.baselineVolume, 1000);
    assert.equal(check.observedVolume, 5, 'baseline is not counted as a trade');
    await store.write('tqsdk', [], [], [], undefined, [
      tick(symbol, 102, 900),
      { ...tick(symbol, 103, 901), volume: null, last: null },
    ]);
    check = await store.validateTickVolumes('tqsdk', symbol, day);
    assert.equal(check.volumeRegressions, 1);
    assert.equal(check.amountRegressions, 1);
    assert.equal(check.invalidRows, 1);
    assert.equal(check.state, 'warning');
    await store.write('tqsdk', [], [], [], undefined, [
      {
        ...tick(symbol, 104, 0),
        timeNs: String(
          BigInt(tick(symbol, 104, 0).timeNs) + 86400_000_000_000n,
        ),
        tradingDay: '2026-10-20',
      },
    ]);
    check = await store.validateTickVolumes('tqsdk', symbol, '2026-10-20');
    assert.equal(check.rows, 1);
    assert.equal(check.volumeRegressions, 0);
    assert.equal(check.amountRegressions, 0);
    assert.equal(check.observedVolume, 0);
  },
);

test(
  'real ClickHouse fences tick-only batches against expired writers',
  { skip: process.env.QUANT_INTEGRATION !== '1' },
  async () => {
    const db = `tick_test_${randomUUID().replaceAll('-', '')}`;
    const store = new MarketStore({ ...config, clickhouseDatabase: db });
    const state = new StateStore({ ...config, clickhouseDatabase: db });
    await store.request(`CREATE DATABASE ${db}`);
    try {
      await store.initialize();
      await state.initialize();
      const owner = randomUUID(),
        successor = randomUUID(),
        symbol = `TEST.${randomUUID()}`;
      assert.equal(await state.acquireLease('tqsdk', owner), true);
      await store.write('tqsdk', [], [], [], owner, [tick(symbol, 0, 0)]);
      await state.releaseLease('tqsdk', owner);
      assert.equal(await state.acquireLease('tqsdk', successor), true);
      await assert.rejects(
        store.write('tqsdk', [], [], [], owner, [tick(symbol, 1, 5)]),
        /WRITER_LEASE_LOST/,
      );
      assert.equal(
        (await store.validateTickVolumes('tqsdk', symbol, day)).rows,
        1,
      );
      await store.write('tqsdk', [], [], [], successor, [tick(symbol, 1, 5)]);
      assert.equal(
        (await store.validateTickVolumes('tqsdk', symbol, day)).rows,
        2,
      );
    } finally {
      await store.request(`DROP DATABASE ${db}`);
    }
  },
);
