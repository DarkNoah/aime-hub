import assert from 'node:assert/strict';
import test from 'node:test';
import { MONTH_DURATION, type Bar } from '../shared.js';
import {
  barEndTime,
  createPosition,
  adjustPosition,
  positionRatio,
  drawingStorageKey,
  sharedDrawingStorageKey,
  logicalAtTime,
  moveDrawing,
  parseDrawings,
  segmentDistance,
  raySegment,
  type Drawing,
} from '../web/drawings/model.js';
import {
  hitPosition,
  positionHandles,
} from '../web/drawings/position-renderer.js';

const bars: Bar[] = [100, 160, 220, 400, 460].map((time) => ({
  symbol: 'TEST',
  duration: 60,
  time,
  open: 10,
  high: 12,
  low: 8,
  close: 11,
  volume: 100,
}));
const line: Drawing = {
  id: 'trend-1',
  kind: 'trend',
  start: { time: 160, price: 10 },
  end: { time: 400, price: 12 },
};

test('drawing storage is scoped by engine, symbol and period and repairs invalid entries', () => {
  assert.notEqual(
    drawingStorageKey('tdx:TEST:60'),
    drawingStorageKey('tdx:TEST:300'),
  );
  assert.notEqual(
    drawingStorageKey('tdx:TEST:60'),
    drawingStorageKey('tqsdk:TEST:60'),
  );
  const horizontal: Drawing = {
    id: 'horizontal-1',
    kind: 'horizontal',
    price: -10,
  };
  assert.deepEqual(parseDrawings(JSON.stringify([line, horizontal])), [
    line,
    horizontal,
  ]);
  assert.deepEqual(
    parseDrawings(
      JSON.stringify([
        line,
        line,
        null,
        {
          id: 'bad',
          kind: 'trend',
          start: { time: 10, price: '12' },
          end: line.end,
        },
        { id: 'bad2', kind: 'horizontal', price: null },
        { id: 'unknown', kind: 'circle' },
        horizontal,
      ]),
    ),
    [line, horizontal],
  );
  for (const raw of [null, '{broken', '{}', 'null'])
    assert.deepEqual(parseDrawings(raw), []);
});

test('anchors survive prepending and interpolate over closed-market gaps', () => {
  assert.equal(logicalAtTime(160, bars), 1);
  assert.equal(logicalAtTime(310, bars), 2.5);
  assert.equal(logicalAtTime(160, [{ ...bars[0], time: 40 }, ...bars]), 2);
  assert.equal(logicalAtTime(40, bars), -1);
  assert.equal(logicalAtTime(520, bars), 5);
  assert.equal(logicalAtTime(100, []), null);
});

test('rays and segments preserve their kind, anchors and cross-period setting after saving and moving', () => {
  for (const kind of ['ray', 'segment'] as const) {
    const drawing: Drawing = { ...line, id: kind, kind, crossPeriod: true };
    assert.deepEqual(parseDrawings(JSON.stringify([drawing])), [drawing]);
    assert.deepEqual(moveDrawing(drawing, 1, 2, bars), {
      ...drawing,
      start: { time: 220, price: 12 },
      end: { time: 460, price: 14 },
    });
    assert.deepEqual(
      parseDrawings(
        JSON.stringify([{ ...drawing, end: { time: 0, price: 1 } }]),
      ),
      [],
    );
  }
});

test('rays extend forward to each pane boundary without extending behind their origin', () => {
  const origin = { x: 50, y: 50 };
  for (const [direction, boundary] of [
    [
      { x: 60, y: 55 },
      { x: 100, y: 75 },
    ],
    [
      { x: 40, y: 55 },
      { x: 0, y: 75 },
    ],
    [
      { x: 55, y: 60 },
      { x: 75, y: 100 },
    ],
    [
      { x: 55, y: 40 },
      { x: 75, y: 0 },
    ],
    [
      { x: 60, y: 50 },
      { x: 100, y: 50 },
    ],
    [
      { x: 50, y: 40 },
      { x: 50, y: 0 },
    ],
    [
      { x: 50, y: 60 },
      { x: 50, y: 100 },
    ],
  ]) {
    assert.deepEqual(raySegment(origin, direction, 100, 100), [
      origin,
      boundary,
    ]);
  }
  assert.deepEqual(raySegment(origin, origin, 100, 100), [origin, origin]);
});

test('ray clipping keeps visible extensions with offscreen anchors and excludes rays pointing away', () => {
  assert.deepEqual(raySegment({ x: -50, y: 20 }, { x: -25, y: 30 }, 100, 100), [
    { x: 0, y: 40 },
    { x: 100, y: 80 },
  ]);
  assert.deepEqual(raySegment({ x: 150, y: 50 }, { x: 125, y: 50 }, 100, 100), [
    { x: 100, y: 50 },
    { x: 0, y: 50 },
  ]);
  for (const [start, end] of [
    [
      { x: -50, y: 50 },
      { x: -75, y: 50 },
    ],
    [
      { x: -50, y: 50 },
      { x: -50, y: 60 },
    ],
    [
      { x: -50, y: -50 },
      { x: -25, y: -75 },
    ],
    [
      { x: -50, y: 50 },
      { x: -50, y: 50 },
    ],
  ]) {
    assert.equal(raySegment(start, end, 100, 100), null);
  }
});

test('cross-period storage preserves sharing and isolates engines and symbols', () => {
  const shared = { ...line, crossPeriod: true };
  assert.deepEqual(parseDrawings(JSON.stringify([shared])), [shared]);
  assert.notEqual(
    sharedDrawingStorageKey('tdx:TEST'),
    drawingStorageKey('tdx:TEST:60'),
  );
  assert.notEqual(
    sharedDrawingStorageKey('tdx:TEST'),
    sharedDrawingStorageKey('tdx:OTHER'),
  );
  assert.notEqual(
    sharedDrawingStorageKey('tdx:TEST'),
    sharedDrawingStorageKey('tqsdk:TEST'),
  );
});

test('fine-period anchors keep their time during vertical moves on coarse candles', () => {
  const coarse = [100, 400, 700].map((time) => ({
    ...bars[0],
    time,
    duration: 300,
  }));
  const fine: Drawing = {
    ...line,
    crossPeriod: true,
    start: { time: 160, price: 10 },
    end: { time: 760, price: 12 },
  };
  assert.equal(logicalAtTime(160, coarse), 0.2);
  assert.equal(logicalAtTime(760, coarse), 2.2);
  assert.deepEqual(moveDrawing(fine, 1, 0, coarse), fine);
  assert.deepEqual(moveDrawing(fine, 0.1, 3, coarse), {
    ...fine,
    start: { time: 160, price: 13 },
    end: { time: 760, price: 15 },
  });
  assert.deepEqual(
    moveDrawing(fine, 1, 0, [
      ...coarse,
      { ...coarse[0], time: 1000 },
      { ...coarse[0], time: 1300 },
    ]),
    {
      ...fine,
      start: { time: 460, price: 10 },
      end: { time: 1060, price: 12 },
    },
  );
});

test('monthly projection uses Shanghai calendar boundaries including leap years', () => {
  const time = Date.parse('2024-02-01T00:00:00+08:00') / 1000;
  const end = Date.parse('2024-03-01T00:00:00+08:00') / 1000;
  const month = { ...bars[0], time, duration: MONTH_DURATION };
  assert.equal(barEndTime(month), end);
  assert.equal(logicalAtTime((time + end) / 2, [month]), 0.5);
});

test('whole-line movement preserves candle distance and price slope across session gaps', () => {
  assert.deepEqual(moveDrawing(line, 1, 2, bars), {
    ...line,
    start: { time: 220, price: 12 },
    end: { time: 460, price: 14 },
  });
  assert.deepEqual(
    moveDrawing(line, 100, 2, bars),
    moveDrawing(line, 1, 2, bars),
  );
  assert.deepEqual(moveDrawing(line, -100, -1, bars), {
    ...line,
    start: { time: 100, price: 9 },
    end: { time: 220, price: 11 },
  });
  assert.deepEqual(
    moveDrawing({ id: 'h', kind: 'horizontal', price: 12 }, 20, -4, bars),
    {
      id: 'h',
      kind: 'horizontal',
      price: 8,
    },
  );
  assert.deepEqual(line.start, { time: 160, price: 10 });
});

test('line hit testing handles endpoints, vertical and zero-length drafts', () => {
  assert.equal(
    segmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }),
    3,
  );
  assert.equal(
    segmentDistance({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }),
    5,
  );
  assert.equal(
    segmentDistance({ x: 3, y: 5 }, { x: 0, y: 0 }, { x: 0, y: 10 }),
    3,
  );
  assert.equal(
    segmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }),
    5,
  );
});

test('long and short positions accept either exit first, persist levels and start with 2:1 reward/risk', () => {
  const entry = { time: 160, price: 100 };
  for (const side of ['long', 'short'] as const) {
    const direction = side === 'long' ? 1 : -1;
    const position = createPosition(side, side, entry, {
      time: 400,
      price: 100 + direction * 20,
    })!;
    assert.equal(position.stop, 100 - direction * 10);
    assert.equal(positionRatio(position), 2);
    assert.deepEqual(
      parseDrawings(JSON.stringify([{ ...position, crossPeriod: true }])),
      [{ ...position, crossPeriod: true }],
    );
    const stopFirst = createPosition(side, side, entry, {
      time: 400,
      price: 100 - direction * 20,
    })!;
    assert.equal(stopFirst.stop, 100 - direction * 20);
    assert.equal(stopFirst.target, 100 + direction * 40);
    assert.equal(positionRatio(stopFirst), 2);
    assert.equal(
      createPosition(side, side, entry, { time: 400, price: entry.price }),
      null,
    );
    assert.equal(
      createPosition(side, side, entry, {
        time: 160,
        price: 100 + direction * 20,
      }),
      null,
    );
    assert.deepEqual(
      parseDrawings(JSON.stringify([{ ...position, stop: position.target }])),
      [],
    );
    assert.deepEqual(
      parseDrawings(JSON.stringify([{ ...position, target: null }])),
      [],
    );
  }
});

test('position controls adjust one level without inverting profit and risk zones', () => {
  for (const side of ['long', 'short'] as const) {
    const direction = side === 'long' ? 1 : -1;
    const position = createPosition(
      side,
      side,
      { time: 160, price: 100 },
      { time: 400, price: 100 + direction * 20 },
    )!;
    const target = adjustPosition(
      position,
      'target',
      100 + direction * 30,
      0.2,
    );
    assert.equal(positionRatio(target), 3);
    assert.equal(target.stop, position.stop);
    assert.equal(target.entry, position.entry);
    const stop = adjustPosition(position, 'stop', 100 - direction * 5, 0.2);
    assert.equal(positionRatio(stop), 4);
    for (const part of ['entry', 'stop', 'target'] as const) {
      for (const price of [-1000, 1000]) {
        const moved = adjustPosition(position, part, price, 0.2);
        assert.ok(direction * (moved.target - moved.entry) > 0);
        assert.ok(direction * (moved.entry - moved.stop) > 0);
        assert.equal(parseDrawings(JSON.stringify([moved])).length, 1);
      }
    }
    assert.deepEqual(moveDrawing(position, 1, 3, bars), {
      ...position,
      start: 220,
      end: 460,
      entry: 103,
      target: position.target + 3,
      stop: position.stop + 3,
    });
  }
});

test('position hit testing distinguishes five controls from a whole-position drag', () => {
  const geometry = { start: 10, end: 110, entry: 80, target: 20, stop: 120 };
  for (const { point, part } of positionHandles(geometry)) {
    assert.equal(hitPosition(point, geometry, true), part);
    assert.equal(
      hitPosition(point, geometry, false),
      part === 'target' || part === 'stop' ? part : 'line',
    );
  }
  assert.equal(hitPosition({ x: 30, y: 40 }, geometry, true), 'line');
  assert.equal(hitPosition({ x: 130, y: 40 }, geometry, true), null);
  assert.equal(
    hitPosition({ x: 30, y: 40 }, { ...geometry, start: 110, end: 10 }, true),
    'line',
  );
});

test('both position directions allow direct exit-edge dragging before selection', () => {
  for (const geometry of [
    { start: 10, end: 110, entry: 80, target: 20, stop: 120 },
    { start: 10, end: 110, entry: 80, target: 120, stop: 20 },
  ]) {
    assert.equal(
      hitPosition({ x: 30, y: geometry.target - 5 }, geometry, false),
      'target',
    );
    assert.equal(
      hitPosition({ x: 30, y: geometry.stop + 5 }, geometry, false),
      'stop',
    );
    assert.equal(
      hitPosition({ x: 30, y: geometry.entry }, geometry, false),
      'line',
    );
  }
  // A narrow risk zone must choose the nearest boundary, not the first match.
  assert.equal(
    hitPosition(
      { x: 30, y: 83 },
      { start: 10, end: 110, entry: 80, target: 76, stop: 84 },
      false,
    ),
    'stop',
  );
});
