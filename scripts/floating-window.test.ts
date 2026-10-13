import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  adjustWindow,
  fitWindow,
  initialWindow,
  type ResizeDirection,
} from '../apps/web/src/components/floating-window/geometry.js';
import {
  readWindowRect,
  saveWindowRect,
} from '../apps/web/src/components/floating-window/storage.js';

const bounds = { width: 1200, height: 800 };
const rect = { x: 200, y: 160, width: 400, height: 400 };

test('moving retains size and keeps the whole window reachable at every boundary', () => {
  assert.deepEqual(adjustWindow(rect, 'move', 64, -32, bounds), {
    ...rect,
    x: 264,
    y: 128,
  });
  assert.deepEqual(adjustWindow(rect, 'move', -2000, -2000, bounds), {
    ...rect,
    x: 8,
    y: 8,
  });
  assert.deepEqual(adjustWindow(rect, 'move', 2000, 2000, bounds), {
    ...rect,
    x: 792,
    y: 392,
  });
});

test('all edges and corners resize while the opposite edges stay fixed', () => {
  const expected: Record<ResizeDirection, [number, number, number, number]> = {
    n: [200, 184, 400, 376],
    s: [200, 160, 400, 424],
    e: [200, 160, 432, 400],
    w: [232, 160, 368, 400],
    ne: [200, 184, 432, 376],
    nw: [232, 184, 368, 376],
    se: [200, 160, 432, 424],
    sw: [232, 160, 368, 424],
  };
  for (const [direction, [x, y, width, height]] of Object.entries(expected)) {
    assert.deepEqual(
      adjustWindow(rect, direction as ResizeDirection, 32, 24, bounds),
      {
        x,
        y,
        width,
        height,
      },
      direction,
    );
  }
});

test('resizing stops at usable minimums and the workspace bounds', () => {
  assert.deepEqual(adjustWindow(rect, 'nw', 2000, 2000, bounds), {
    x: 280,
    y: 240,
    width: 320,
    height: 320,
  });
  assert.deepEqual(adjustWindow(rect, 'se', -2000, -2000, bounds), {
    ...rect,
    width: 320,
    height: 320,
  });
  assert.deepEqual(adjustWindow(rect, 'nw', -2000, -2000, bounds), {
    x: 8,
    y: 8,
    width: 592,
    height: 552,
  });
  assert.deepEqual(adjustWindow(rect, 'se', 2000, 2000, bounds), {
    ...rect,
    width: 992,
    height: 632,
  });
});

test('initial and saved windows fit a reduced workspace, even below minimum size', () => {
  assert.deepEqual(initialWindow(bounds), {
    x: 16,
    y: 264,
    width: 384,
    height: 520,
  });
  const smallBounds = { width: 280, height: 240 };
  const fitted = { x: 8, y: 8, width: 264, height: 224 };
  assert.deepEqual(initialWindow(smallBounds), fitted);
  assert.deepEqual(fitWindow(rect, smallBounds), fitted);
  assert.deepEqual(adjustWindow(rect, 'se', 2000, 2000, smallBounds), fitted);
  assert.deepEqual(fitWindow(rect, { width: 0, height: 0 }), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
});

function mockStorage(t: TestContext, value: string | null = null) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  if (value !== null) values.set('chat-floating-window:v1', value);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, next: string) => values.set(key, next),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return values;
}

test('floating geometry persists all four values and restores within current bounds', (t) => {
  const values = mockStorage(t);
  const key = 'chat-floating-window:v1';
  assert.equal(readWindowRect(key), null);
  saveWindowRect(key, rect);
  assert.deepEqual(JSON.parse(values.get(key)!), rect);
  assert.deepEqual(readWindowRect(key), rect);
  assert.deepEqual(
    fitWindow(readWindowRect(key)!, { width: 350, height: 360 }),
    {
      x: 8,
      y: 8,
      width: 334,
      height: 344,
    },
  );
  // Automatic fitting should not overwrite the user's preferred dimensions.
  assert.deepEqual(readWindowRect(key), rect);
});

test('corrupt or invalid stored geometry falls back without throwing', (t) => {
  const values = mockStorage(t);
  const key = 'chat-floating-window:v1';
  for (const value of [
    'broken JSON',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...rect, x: '200' }),
    JSON.stringify({ ...rect, width: 0 }),
    JSON.stringify({ ...rect, height: -1 }),
    '{"x":1e999,"y":0,"width":400,"height":400}',
  ]) {
    values.set(key, value);
    assert.equal(readWindowRect(key), null);
  }
  values.delete(key);
  saveWindowRect(key, { ...rect, width: 0 });
  saveWindowRect(key, { ...rect, y: Number.NaN });
  assert.equal(values.has(key), false);
});

test('unavailable browser storage does not interrupt floating window interactions', (t) => {
  mockStorage(t);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      throw new Error('Storage is blocked');
    },
  });
  assert.equal(readWindowRect('chat-floating-window:v1'), null);
  assert.doesNotThrow(() => saveWindowRect('chat-floating-window:v1', rect));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded');
      },
    },
  });
  assert.doesNotThrow(() => saveWindowRect('chat-floating-window:v1', rect));
});
