import assert from 'node:assert/strict';
import test from 'node:test';
import type { IChartApi } from 'lightweight-charts';
import type { Bar } from '../shared.js';
import {
  DrawingPrimitive,
  type PriceSeries,
} from '../web/drawings/primitive.js';
import type { Drawing, FibonacciDrawing } from '../web/drawings/model.js';

const bars: Bar[] = [100, 160, 220, 400, 460].map((time) => ({
  symbol: 'TEST',
  duration: 60,
  time,
  open: 50,
  high: 60,
  low: 40,
  close: 50,
  volume: 100,
}));
const line: Drawing = {
  id: 'line',
  kind: 'ray',
  start: { time: 160, price: 40 },
  end: { time: 220, price: 60 },
};

function primitive(loadedBars = bars) {
  const chart = {
    timeScale: () => ({
      logicalToCoordinate: (logical: number) => logical * 40,
      width: () => 200,
    }),
    panes: () => [{ getHeight: () => 120 }],
  } as unknown as IChartApi;
  const series = {
    priceToCoordinate: (price: number) => price,
  } as unknown as PriceSeries;
  const result = new DrawingPrimitive(chart, series);
  result.bars = loadedBars;
  return result;
}

test('ray extensions are selectable but segments and existing trend lines stay finite', () => {
  const view = primitive();
  for (const kind of ['ray', 'segment', 'trend'] as const) {
    view.drawings = [{ ...line, kind }];
    assert.deepEqual(view.hit({ x: 60, y: 50 }), { id: 'line', part: 'line' });
    assert.deepEqual(
      view.hit({ x: 160, y: 100 }),
      kind === 'ray' ? { id: 'line', part: 'line' } : null,
    );
    assert.equal(view.hit({ x: 0, y: 20 }), null);
    assert.equal(view.hit({ x: 210, y: 125 }), null);
  }
});

test('selected rays expose original anchor handles instead of the clipped extension endpoint', () => {
  const view = primitive();
  for (const kind of ['ray', 'segment'] as const) {
    view.drawings = [{ ...line, kind }];
    view.selected = line.id;
    assert.deepEqual(view.hit({ x: 40, y: 40 }), { id: 'line', part: 'start' });
    assert.deepEqual(view.hit({ x: 80, y: 60 }), { id: 'line', part: 'end' });
    assert.deepEqual(
      view.hit({ x: 200, y: 120 }),
      kind === 'ray' ? { id: 'line', part: 'line' } : null,
    );
  }
});

test('rays remain selectable after both anchors leave the loaded candle window', () => {
  const view = primitive(bars.slice(3));
  const ray: Drawing = {
    ...line,
    start: { time: 100, price: 50 },
    end: { time: 160, price: 50 },
  };
  view.drawings = [ray];
  assert.deepEqual(view.hit({ x: 100, y: 50 }), { id: 'line', part: 'line' });
  view.drawings = [{ ...ray, start: ray.end, end: ray.start }];
  assert.equal(view.hit({ x: 100, y: 50 }), null);
  view.drawings = [{ ...ray, kind: 'segment' }];
  assert.equal(view.hit({ x: 100, y: 50 }), null);
});

test('Fibonacci levels select the whole drawing and its two anchors remain editable', () => {
  const view = primitive();
  view.drawings = [
    {
      id: 'fib',
      kind: 'fibonacci',
      start: { time: 160, price: 110 },
      end: { time: 400, price: 10 },
    },
  ];
  assert.deepEqual(view.hit({ x: 50, y: 60 }), { id: 'fib', part: 'line' });
  assert.equal(view.hit({ x: 180, y: 60 }), null);
  view.selected = 'fib';
  assert.deepEqual(view.hit({ x: 40, y: 110 }), { id: 'fib', part: 'start' });
  assert.deepEqual(view.hit({ x: 120, y: 10 }), { id: 'fib', part: 'end' });
});

test('extended Fibonacci levels stay selectable when the original candles are no longer loaded', () => {
  const view = primitive(bars.slice(3));
  const fibonacci: FibonacciDrawing = {
    id: 'fib',
    kind: 'fibonacci',
    start: { time: 100, price: 110 },
    end: { time: 160, price: 10 },
    extendRight: true,
  };
  view.drawings = [fibonacci];
  assert.deepEqual(view.hit({ x: 100, y: 60 }), { id: 'fib', part: 'line' });
  view.drawings = [{ ...fibonacci, extendRight: false }];
  assert.equal(view.hit({ x: 100, y: 60 }), null);
});
