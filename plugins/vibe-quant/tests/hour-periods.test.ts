import assert from 'node:assert/strict';
import test from 'node:test';
import { durationLabel, type Bar } from '../shared.js';
import { marketChartUrl, readMarketChartTarget } from '../market-navigation.js';
import { parseChartPeriod } from '../web/chart-period.js';
import { marketBarsQuery } from '../server/market-bars.js';
import { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { aggregateBars } from '../server/bar-periods.js';
import {
  nativeMarketWindow,
  replayQuerySchema,
} from '../server/strategies/replay.js';
import { smcIndicator } from '../web/indicators/main/smc.js';
import { smcBucket } from '../web/indicators/main/smc/engine.js';
import { defaultParameters } from '../web/indicators/preferences.js';

const start = Date.parse('2026-10-19T00:00:00Z') / 1000;
const symbol = 'SSE.000852';
const minute = (index: number): Bar => ({
  symbol,
  duration: 60,
  time: start + index * 60,
  open: index + 10,
  high: index + 12,
  low: index + 9,
  close: index + 11,
  volume: 1,
  amount: 2,
});

for (const hours of [2, 3, 4]) {
  const duration = hours * 3600;
  const count = duration / 60;

  test(`${hours}-hour views restore preferences, preserve navigation and support SMC`, () => {
    assert.equal(parseChartPeriod(String(duration)), duration);
    assert.equal(durationLabel(duration), `${hours} 小时`);
    const target = { symbol, duration, time: start };
    assert.deepEqual(
      readMarketChartTarget(
        new URL(marketChartUrl(target), 'http://local').search,
      ),
      { ...target, monitor: undefined },
    );
    assert.equal(
      marketBarsQuery.parse({ duration: String(duration) }).duration,
      duration,
    );
    assert.equal(replayQuerySchema.parse({ duration }).duration, duration);
    const timeframe = `${hours * 60}m`;
    assert.equal(smcBucket(start + duration - 1, timeframe), start);
    const parameters = defaultParameters(smcIndicator);
    assert.ok(
      smcIndicator.parameters.some(
        (field) =>
          field.key === 'fairValueGapsTimeframeInput' &&
          field.type === 'select' &&
          field.options.some((option) => option.value === timeframe),
      ),
    );
    const result = smcIndicator.renderOverlay!(
      Array.from({ length: 60 }, (_, index) => ({
        ...minute(index),
        duration,
        time: start + index * duration,
      })),
      parameters,
      duration,
    );
    assert.ok(
      !result.warnings?.some((warning) => warning.includes('暂不支持当前周期')),
    );
    assert.ok(result.drawings.length > 0);
    assert.ok(
      result.drawings.every((drawing) =>
        [drawing.from, drawing.to, drawing.top, drawing.bottom].every(
          Number.isFinite,
        ),
      ),
    );
  });

  test(`${hours}-hour market pages preserve full candles, live corrections and frozen replay parity`, async () => {
    const source = Array.from({ length: count * 5 + 17 }, (_, i) => minute(i));
    const expectedGroup = (index: number): Bar => ({
      ...minute(index * count),
      duration,
      high: (index + 1) * count + 11,
      close: (index + 1) * count + 10,
      volume: count,
      amount: count * 2,
    });
    for (const clickhouseReadOnly of [false, true]) {
      const store = new MarketStore(
        parseConfig({
          engine: 'tdx',
          clickhouseUrl: 'http://127.0.0.1:8123',
          clickhouseDatabase: 'fixture',
          clickhouseReadOnly,
          clickhouseUser: 'reader',
          clickhousePassword: 'fixture',
          tdxServers: '127.0.0.1:7709',
          beforeOpenMinutes: 5,
          afterCloseMinutes: 10,
          flushSeconds: 2,
          pollSeconds: 5,
          historyBars: 1000,
          maxSubscriptions: 100,
        }),
      );
      store.request = async (query, params = {}) => {
        assert.equal(params.engine, 'tdx');
        assert.equal(params.symbol, symbol);
        assert.equal(params.duration, '60');
        const forward = query.includes('ORDER BY time ASC');
        return JSON.stringify({
          data: source
            .filter(
              (bar) =>
                bar.time < Number(params.before) &&
                (params.after === undefined || bar.time > Number(params.after)),
            )
            .sort((a, b) => (forward ? a.time - b.time : b.time - a.time))
            .slice(0, Number(params.limit)),
        });
      };
      const last = source.at(-1)!;
      const corrected = {
        ...last,
        high: 9999,
        close: 9998,
        volume: 3,
        amount: 6,
      };
      if (clickhouseReadOnly) await store.write('tdx', [], [corrected]);
      const latest = await store.bars('tdx', symbol, duration, { limit: 2 });
      assert.equal(latest.length, 2);
      assert.deepEqual(latest[0], expectedGroup(4));
      assert.deepEqual(latest[1], {
        ...minute(5 * count),
        duration,
        high: clickhouseReadOnly ? corrected.high : last.high,
        close: clickhouseReadOnly ? corrected.close : last.close,
        volume: clickhouseReadOnly ? 19 : 17,
        amount: clickhouseReadOnly ? 38 : 34,
      });
      const older = await store.bars('tdx', symbol, duration, {
        before: latest[0].time,
        limit: 2,
      });
      assert.deepEqual(older, [expectedGroup(2), expectedGroup(3)]);
      assert.deepEqual(
        await store.bars('tdx', symbol, duration, {
          after: older.at(-1)!.time,
          limit: 2,
        }),
        latest,
      );
      const window = await store.barsAround(
        'tdx',
        symbol,
        duration,
        start + 3.5 * duration,
      );
      assert.equal(window.targetTime, start + 3 * duration);
      const snapshot = source.map((bar) =>
        clickhouseReadOnly && bar.time === last.time ? corrected : bar,
      );
      assert.deepEqual(
        nativeMarketWindow(
          {
            instruments: [],
            events: snapshot.map((bar) => ({
              type: 'bar',
              payload: { ...bar, trading_day: '2026-10-19' },
            })),
          },
          { symbol },
          { duration, limit: 2 },
        ),
        latest,
      );
    }
    const sparse = aggregateBars(
      [minute(0), minute(count - 1), minute(count * 2)],
      duration,
    );
    assert.deepEqual(
      sparse.map((bar) => bar.time),
      [start, start + 2 * duration],
    );
    assert.equal(sparse[0].volume, 2);
  });
}
