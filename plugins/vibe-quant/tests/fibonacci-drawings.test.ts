import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar } from '../shared.js';
import {
  fibonacciOptions,
  moveDrawing,
  parseDrawings,
  type FibonacciDrawing,
} from '../web/drawings/model.js';
import {
  fibonacciGeometry,
  fibonacciLevels,
  hitFibonacci,
} from '../web/drawings/fibonacci-renderer.js';

const drawing: FibonacciDrawing = {
  id: 'fib',
  kind: 'fibonacci',
  start: { time: 100, price: 100 },
  end: { time: 220, price: 200 },
};

test('retracement starts at the second anchor and reaches the first anchor at 100%', () => {
  const levels = fibonacciLevels(drawing);
  assert.deepEqual(
    levels.map(({ ratio }) => ratio),
    [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  );
  const prices = [200, 176.4, 161.8, 150, 138.2, 121.4, 100];
  levels.forEach(({ price }, i) =>
    assert.ok(Math.abs(price - prices[i]) < 1e-10),
  );
  for (const input of [
    { ...drawing, start: drawing.end, end: drawing.start },
    { ...drawing, reverse: true },
  ]) {
    const reversed = fibonacciLevels(input);
    assert.equal(reversed[0].price, 100);
    assert.equal(reversed[4].price, 161.8);
    assert.equal(reversed.at(-1)!.price, 200);
  }
});

test('retracement is based on signed prices, independently of anchor time order', () => {
  const input = {
    ...drawing,
    start: { time: 220, price: -20 },
    end: { time: 100, price: 20 },
  };
  const levels = fibonacciLevels(input);
  assert.equal(levels[0].price, 20);
  assert.equal(levels[3].price, 0);
  assert.equal(levels.at(-1)!.price, -20);
  assert.ok(
    fibonacciLevels({ ...drawing, end: drawing.start }).every(
      ({ price }) => price === 100,
    ),
  );
});

test('Fibonacci anchors and options round-trip without losing older line kinds', () => {
  const saved = {
    ...drawing,
    crossPeriod: true,
    reverse: true,
    extendLeft: false,
    extendRight: true,
    background: false,
  };
  const trend = {
    id: 'trend',
    kind: 'trend',
    start: drawing.start,
    end: drawing.end,
  };
  assert.deepEqual(parseDrawings(JSON.stringify([saved, trend])), [
    saved,
    trend,
  ]);
  assert.deepEqual(fibonacciOptions(drawing), {
    reverse: false,
    extendLeft: false,
    extendRight: false,
    background: true,
  });
  const repaired = parseDrawings(
    JSON.stringify([
      { ...drawing, reverse: 'true', extendRight: 1, background: null },
    ]),
  );
  assert.deepEqual(repaired, [drawing]);
  assert.deepEqual(
    parseDrawings(
      JSON.stringify([{ ...drawing, end: { time: 100, price: '200' } }]),
    ),
    [],
  );
});

test('moving a retracement shifts every level equally and preserves its settings', () => {
  const bars: Bar[] = [100, 160, 220, 400, 460].map((time) => ({
    symbol: 'TEST',
    time,
    duration: 60,
    open: 100,
    high: 200,
    low: 100,
    close: 200,
    volume: 1,
  }));
  const original = {
    ...drawing,
    reverse: true,
    extendRight: true,
    background: false,
    crossPeriod: true,
  };
  const moved = moveDrawing(original, 1, 20, bars);
  assert.equal(moved.kind, 'fibonacci');
  if (moved.kind !== 'fibonacci') throw new Error('wrong drawing kind');
  assert.deepEqual(moved, {
    ...original,
    start: { time: 160, price: 120 },
    end: { time: 400, price: 220 },
  });
  const before = fibonacciLevels(original),
    after = fibonacciLevels(moved);
  after.forEach((level, i) =>
    assert.ok(Math.abs(level.price - before[i].price - 20) < 1e-10),
  );
});

test('level geometry projects calculated prices rather than interpolating screen coordinates', () => {
  const project = (price: number) => 1000 - Math.log(price) * 100;
  const anchors: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 20, y: project(100) },
    { x: 120, y: project(200) },
  ];
  const geometry = fibonacciGeometry(drawing, anchors, 300, project)!;
  assert.equal(geometry.levels[3].y, project(150));
  assert.notEqual(geometry.levels[3].y, (anchors[0].y + anchors[1].y) / 2);
  assert.equal(geometry.left, 20);
  assert.equal(geometry.right, 120);
});

test('level lines and the baseline are draggable while empty space outside is not', () => {
  const geometry = fibonacciGeometry(
    drawing,
    [
      { x: 20, y: 100 },
      { x: 120, y: 200 },
    ],
    300,
    (price) => price,
  )!;
  for (const { y } of geometry.levels)
    assert.equal(hitFibonacci({ x: 30, y }, geometry), true);
  assert.equal(hitFibonacci({ x: 100, y: 180 }, geometry), true);
  assert.equal(hitFibonacci({ x: 180, y: 150 }, geometry), false);
  assert.equal(hitFibonacci({ x: 80, y: 230 }, geometry), false);
  const extended = fibonacciGeometry(
    { ...drawing, extendLeft: true, extendRight: true },
    [geometry.start, geometry.end],
    300,
    (price) => price,
  )!;
  assert.equal(hitFibonacci({ x: 280, y: 150 }, extended), true);
  assert.equal(hitFibonacci({ x: 0, y: 150 }, extended), true);
});

test('extensions retain offscreen anchors and clip their horizontal span to the pane', () => {
  const anchors: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: -120, y: 100 },
    { x: -20, y: 200 },
  ];
  assert.equal(
    fibonacciGeometry(drawing, anchors, 300, (price) => price),
    null,
  );
  const extended = fibonacciGeometry(
    { ...drawing, extendRight: true },
    anchors,
    300,
    (price) => price,
  )!;
  assert.equal(extended.left, 0);
  assert.equal(extended.right, 300);
  assert.equal(hitFibonacci({ x: 200, y: 150 }, extended), true);
  assert.deepEqual(
    fibonacciGeometry(
      drawing,
      [
        { x: 20, y: 100 },
        { x: 120, y: 200 },
      ],
      300,
      () => null,
    )!.levels,
    [],
  );
});
