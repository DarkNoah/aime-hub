import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneRenderer,
} from 'lightweight-charts';
import { IndicatorRenderer } from '../web/indicators/renderer';
import { parsePreferences } from '../web/indicators/preferences';
import type { Bar } from '../shared';
import { buildPriceProfile, profileRangeStart } from '../volume-profile';

function harness(candles = true) {
  const primitives = new Set<ISeriesPrimitive>();
  const writes: { time: number; color?: string; wickColor?: string }[][] = [];
  const warnings: string[][] = [];
  let additions = 0;
  let removals = 0;
  let range = { from: 5, to: 30 };
  const chart = {
    timeScale: () => ({
      getVisibleLogicalRange: () => range,
      setVisibleLogicalRange: (value: typeof range) => {
        range = value;
      },
      logicalToCoordinate: (index: number) => index * 10,
    }),
    panes: () => [{ setPreserveEmptyPane() {} }],
    addPane: () => {
      throw new Error('SMC must not create an extra pane');
    },
    removeSeries: () => {
      throw new Error('SMC must not create or remove price series');
    },
  } as unknown as IChartApi;
  const series = {
    seriesType: () => (candles ? 'Candlestick' : 'Line'),
    priceToCoordinate: (price: number) => 300 - price * 10,
    attachPrimitive: (primitive: ISeriesPrimitive) => {
      additions++;
      primitives.add(primitive);
      primitive.attached?.({ chart, series, requestUpdate() {} } as Parameters<
        NonNullable<typeof primitive.attached>
      >[0]);
    },
    detachPrimitive: (primitive: ISeriesPrimitive) => {
      removals++;
      primitive.detached?.();
      primitives.delete(primitive);
    },
    setData: (data: (typeof writes)[number]) => writes.push(data),
  } as unknown as ISeriesApi<'Candlestick'>;
  const preferences = parsePreferences(null);
  for (const [id, preference] of Object.entries(preferences))
    preference.visible = id === 'smc';
  preferences.smc.parameters.swingsLengthInput = 10;
  preferences.smc.parameters.showSwingOrderBlocksInput = true;
  const renderer = new IndicatorRenderer(
    chart,
    { type: 'price', precision: 2, minMove: 0.01 },
    60,
    series,
    (value) => warnings.push(value),
  );
  return {
    renderer,
    preferences,
    primitives,
    writes,
    warnings,
    counts: () => ({ additions, removals }),
    range: () => range,
  };
}

const bar = (
  index: number,
  close: number,
  high = close + 1,
  low = close - 1,
): Bar => ({
  symbol: 'TEST',
  duration: 60,
  time: 1700000040 + index * 60,
  open: close,
  close,
  high,
  low,
  volume: 1,
});
const bars = [
  bar(0, 5.5, 6, 5),
  ...Array.from({ length: 10 }, (_, i) => bar(i + 1, 10)),
  bar(11, 19, 20, 18),
  ...Array.from({ length: 10 }, (_, i) => bar(i + 12, 10)),
  bar(22, 21),
];

function draw(primitive: ISeriesPrimitive) {
  const labels: string[] = [];
  let boxes = 0;
  const target = {
    useMediaCoordinateSpace: (fn: (scope: unknown) => void) =>
      fn({
        mediaSize: { width: 500, height: 400 },
        context: {
          save() {},
          restore() {},
          beginPath() {},
          rect() {},
          clip() {},
          setLineDash() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          strokeRect() {},
          fillRect() {
            boxes++;
          },
          fillText(text: string) {
            labels.push(text);
          },
        },
      }),
  } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0];
  const renderer = primitive.paneViews!()[0].renderer()!;
  renderer.drawBackground?.(target);
  renderer.draw(target);
  return { labels, boxes };
}

test('SMC reconciles one primitive, paints BOS and boxes, withdraws revised signals, preserves viewport and detaches', () => {
  const h = harness();
  h.renderer.update(bars, h.preferences);
  const primitive = [...h.primitives][0];
  assert.ok(draw(primitive).labels.includes('BOS'));
  assert.ok(draw(primitive).boxes > 0);
  h.renderer.update(bars, h.preferences);
  assert.deepEqual(h.counts(), { additions: 1, removals: 0 });
  assert.equal(h.warnings.length, 1);
  h.renderer.update([...bars.slice(0, -1), bar(22, 19)], h.preferences);
  assert.equal(draw(primitive).labels.includes('BOS'), false);
  assert.deepEqual(h.range(), { from: 5, to: 30 });
  const hidden = {
    ...h.preferences,
    smc: { ...h.preferences.smc, visible: false },
  };
  h.renderer.update(bars, hidden);
  assert.equal(h.primitives.size, 0);
  assert.deepEqual(h.warnings.at(-1), []);
  h.renderer.update(bars, h.preferences);
  h.renderer.dispose();
  assert.deepEqual(h.counts(), { additions: 2, removals: 2 });
});

test('candle tinting aligns with chart labels and restores base candles after hiding', () => {
  const h = harness();
  h.preferences.smc.parameters.showTrendInput = true;
  h.renderer.update(bars, h.preferences);
  assert.equal(h.writes.at(-1)![0].time, bars[0].time + 60);
  assert.ok(h.writes.at(-1)!.every((p) => p.color && p.wickColor === p.color));
  h.renderer.update(bars, {
    ...h.preferences,
    smc: { ...h.preferences.smc, visible: false },
  });
  assert.ok(
    h.writes
      .at(-1)!
      .every((p) => p.color === undefined && p.wickColor === undefined),
  );
  assert.deepEqual(h.range(), { from: 5, to: 30 });
  h.renderer.dispose();
});

test('intraday line charts skip SMC without erasing its saved preference', () => {
  const h = harness(false);
  h.renderer.update(bars, h.preferences);
  assert.equal(h.primitives.size, 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.preferences.smc.visible, true);
  h.renderer.dispose();
});

test('volume profile refreshes asynchronous context without resetting the chart and detaches when hidden', () => {
  const h = harness();
  h.preferences.smc.visible = false;
  h.preferences.volumeProfile.visible = true;
  h.renderer.update(bars, h.preferences);
  const primitive = [...h.primitives][0];
  assert.equal(draw(primitive).boxes, 0);
  const context = {
    volumeProfile: {
      source: 'fixture',
      warnings: [],
      segments: [
        {
          start: profileRangeStart(bars[0].time, 86400),
          end: bars.at(-1)!.time + 60,
          profile: buildPriceProfile(
            [{ price: 10, size: 20, side: 'unknown' }],
            30,
            70,
          )!,
        },
      ],
    },
  };
  h.renderer.update(bars, h.preferences, context);
  assert.equal(draw(primitive).boxes, 1);
  assert.deepEqual(draw(primitive).labels, ['POC', 'VAH', 'VAL', 'VWAP']);
  assert.deepEqual(h.range(), { from: 5, to: 30 });
  h.renderer.update(bars, h.preferences, {
    volumeProfile: { ...context.volumeProfile, segments: [] },
  });
  assert.equal(draw(primitive).boxes, 0);
  h.renderer.update(
    bars,
    {
      ...h.preferences,
      volumeProfile: { ...h.preferences.volumeProfile, visible: false },
    },
    context,
  );
  assert.equal(h.primitives.size, 0);
  h.renderer.dispose();
  assert.deepEqual(h.counts(), { additions: 1, removals: 1 });
});
