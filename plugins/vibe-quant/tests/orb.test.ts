import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar } from '../shared';
import { orbIndicator } from '../web/indicators/main/orb';
import { calculateOrb, orbFeatures } from '../web/indicators/main/orb/engine';
import { orbStatistics } from '../web/indicators/main/orb/display';
import { orbSettings } from '../web/indicators/main/orb/settings';
import {
  defaultParameters,
  parsePreferences,
  validateParameters,
} from '../web/indicators/preferences';
import type { IndicatorParameters } from '../web/indicators/types';

const start = Date.parse('2026-10-27T09:30:00+08:00') / 1000;
function bar(minute: number, close = 105, high = 110, low = 100): Bar {
  return {
    symbol: 'TEST',
    duration: 60,
    time: start + minute * 60,
    open: close,
    high,
    low,
    close,
    volume: 1,
  };
}
const opening = () => Array.from({ length: 31 }, (_, i) => bar(i - 1));
const render = (bars: Bar[], patch: IndicatorParameters = {}, duration = 60) =>
  calculateOrb(
    bars,
    orbSettings({ ...defaultParameters(orbIndicator), ...patch }),
    duration,
  );
const entry = () => [
  ...opening(),
  bar(30, 111, 112, 110),
  bar(31, 111, 112, 109),
];
const near = (actual: number | undefined, expected: number) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${actual} != ${expected}`,
  );

test('Flux ORB defaults, source attribution, time validation and storage round-trip', () => {
  const parameters = defaultParameters(orbIndicator);
  assert.deepEqual(
    [
      parameters.rangeMinutes,
      parameters.sensitivity,
      parameters.tpMethod,
      parameters.emaLength,
      parameters.slMethod,
      parameters.adaptiveSL,
    ],
    [30, 'Medium', 'Dynamic', '9', 'Balanced', true],
  );
  assert.equal(orbIndicator.type, 'main');
  assert.equal(orbIndicator.requiresCandles, true);
  assert.match(orbIndicator.source!.name, /fluxchart.*MPL/i);
  const preferences = parsePreferences(null);
  assert.equal(preferences.orb.visible, false);
  preferences.orb = {
    visible: true,
    parameters: {
      ...parameters,
      customSessionEnabled: true,
      customSessionStart: '21:00',
      customSessionEnd: '02:30',
      sensitivity: 'Low',
    },
  };
  assert.deepEqual(parsePreferences(JSON.stringify(preferences)), preferences);
  for (const value of ['', '9:30', '24:00', '09:60', 930]) {
    assert.ok(
      validateParameters(orbIndicator, {
        ...parameters,
        regularSessionStart: value,
      }),
    );
    assert.equal(
      parsePreferences(
        JSON.stringify({ orb: { parameters: { regularSessionStart: value } } }),
      ).orb.parameters.regularSessionStart,
      '09:30',
    );
  }
});

test('HL2 EMA and ATR12 match manual seeds; EMA is optional and uses raw start timestamps', () => {
  const data = Array.from({ length: 13 }, (_, i) => bar(i, 10, 12, 8));
  data[12] = bar(12, 15, 16, 12);
  const features = orbFeatures(data, 9);
  assert.equal(features.ema[0], 10);
  near(features.ema[12], 10.8);
  assert.ok(features.atr.slice(0, 11).every((value) => value === undefined));
  near(features.atr[11], 4);
  near(features.atr[12], (4 * 11 + 6) / 12);
  assert.deepEqual(
    orbIndicator.render(data, defaultParameters(orbIndicator)),
    [],
  );
  const plot = orbIndicator.render(data, {
    ...defaultParameters(orbIndicator),
    plotEMA: true,
  })[0];
  assert.equal(plot.data[12].time, data[12].time);
  near(plot.data[12].value, 10.8);
});

test('30 minute range freezes at 10:00 and Medium waits for a later strict wick retest', () => {
  const data = [
    ...opening(),
    bar(30, 111, 112, 109),
    bar(31, 111, 112, 110),
    bar(32, 110, 112, 109),
    bar(33, 111, 112, 109),
  ];
  const result = render(data);
  const orb = result.sessions[0];
  assert.deepEqual(
    [orb.startIndex, orb.high, orb.low, orb.entryIndex, orb.entryPrice],
    [1, 110, 100, 34, 111],
  );
  assert.equal(orb.breakouts[0].retests, 1);
  assert.equal(orb.slPrice, 105);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['Buy'],
  );
  const before = render(data.slice(0, 31));
  assert.equal(before.sessions[0].state, 'Opening Range');
  assert.equal(before.sessions[0].entryIndex, undefined);
  assert.ok(result.drawings.some((drawing) => drawing.text === 'Buy'));
  assert.equal(
    result.drawings.filter((drawing) => drawing.kind === 'line').length,
    2,
  );
});

test('sensitivity counts 0/1/2/3 retests, failed breakouts reset and shorts mirror longs', () => {
  const data = [
    ...opening(),
    bar(30, 111, 112, 110),
    ...[31, 32, 33].map((minute) => bar(minute, 111, 112, 109)),
  ];
  for (const [needed, sensitivity] of [
    'High',
    'Medium',
    'Low',
    'Lowest',
  ].entries()) {
    assert.equal(
      render(data, { sensitivity }).sessions[0].entryIndex,
      31 + needed,
    );
  }
  const retry = render([
    ...opening(),
    bar(30, 111, 112, 110),
    bar(31),
    bar(32, 111, 112, 109),
    bar(33, 111, 112, 109),
  ]);
  assert.equal(retry.sessions[0].breakouts.length, 2);
  assert.equal(retry.sessions[0].breakouts[0].failed, true);
  assert.equal(retry.sessions[0].entryIndex, 34);
  const short = render([
    ...opening(),
    bar(30, 99, 100, 98),
    bar(31, 99, 101, 98),
  ]);
  assert.deepEqual(
    short.events.map((event) => event.type),
    ['Sell'],
  );
  assert.equal(short.sessions[0].slPrice, 105);
});

test('EMA breakthrough uses HL2 and preserves High entry after a same-bar close failure', () => {
  const data = [...opening(), bar(30, 105, 200, 100)];
  assert.equal(
    render(data, { sensitivity: 'High' }).sessions[0].entryIndex,
    undefined,
  );
  const result = render(data, {
    sensitivity: 'High',
    breakoutCondition: 'EMA',
  });
  assert.equal(result.sessions[0].breakouts[0].failed, true);
  assert.equal(result.sessions[0].entryIndex, 31);
  assert.equal(result.events[0].type, 'Buy');
});

test('three SL positions, strict stop touch and one entry per session match source', () => {
  for (const [slMethod, value] of [
    ['Safer', 107.5],
    ['Balanced', 105],
    ['Risky', 102.5],
  ] as const) {
    assert.equal(render(entry(), { slMethod }).sessions[0].slPrice, value);
  }
  const result = render([
    ...entry(),
    bar(32, 106, 108, 105),
    bar(33, 106, 108, 104),
    bar(34, 111, 112, 109),
  ]);
  assert.equal(result.sessions[0].slIndex, 34);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['Buy', 'SL'],
  );
});

test('ATR targets are entry ATR multiples; only one target per bar and TP takes precedence over SL', () => {
  const data = [
    ...opening(),
    bar(30, 111, 200, 104),
    bar(31, 112, 250, 90),
    bar(32, 113, 250, 90),
    bar(33, 90, 100, 80),
  ];
  const result = render(data, { sensitivity: 'High', tpMethod: 'ATR' });
  const orb = result.sessions[0];
  const expectedATR = (10 * 11 + 96) / 12;
  near(orb.entryATR, expectedATR);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['Buy', 'TP 1', 'TP 2', 'TP 3'],
  );
  for (const [index, mult] of [0.75, 1.5, 2.25].entries())
    near(orb.targets[index].price, 111 + expectedATR * mult);
  assert.deepEqual(
    orb.targets.map((target) => target.index),
    [31, 32, 33],
  );
  assert.equal(orb.slIndex, -1);
  assert.equal(orb.slPrice, 111);
  assert.equal(
    render(data, { sensitivity: 'High', tpMethod: 'ATR', adaptiveSL: false })
      .sessions[0].slPrice,
    105,
  );
  const shortData = data.map((value) => ({
    ...value,
    open: 210 - value.open,
    close: 210 - value.close,
    high: 210 - value.low,
    low: 210 - value.high,
  }));
  const short = render(shortData, { sensitivity: 'High', tpMethod: 'ATR' });
  assert.deepEqual(
    short.events.map((event) => event.type),
    ['Sell', 'TP 1', 'TP 2', 'TP 3'],
  );
});

test('Dynamic TP requires profitable EMA, 0.2% minimum, reversal and incremental improvement', () => {
  const data = [
    ...entry(),
    ...[32, 33, 34, 35].map((minute) => bar(minute, 130, 132, 128)),
    bar(36, 112, 132, 112),
    bar(37, 112, 132, 112),
    bar(38, 112, 132, 112),
    bar(39, 112, 112, 110),
  ];
  const result = render(data);
  const orb = result.sessions[0];
  assert.equal(orb.targets.length, 3);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['Buy', 'TP 1', 'TP 2', 'TP 3'],
  );
  assert.equal(orb.targets[0].index, 37);
  for (const target of orb.targets)
    near(target.price, result.ema[target.index]!);
  const narrow = [
    ...opening(),
    bar(30, 110.01, 110.02, 110),
    ...Array.from({ length: 100 }, (_, i) =>
      bar(31 + i, 110.02, 110.04, 110.01),
    ),
    bar(131, 110.01, 110.04, 110.01),
  ];
  assert.equal(
    render(narrow, { sensitivity: 'High' }).sessions[0].targets.length,
    0,
  );
});

test('new sessions force Exit at previous close; replay has no future exit or entries and revisions retract', () => {
  const first = entry();
  const newOpen = { ...bar(0), time: start + 86400 };
  const before = render(first);
  assert.equal(
    before.events.some((event) => event.type === 'Exit'),
    false,
  );
  const after = render([...first, newOpen]);
  assert.equal(after.sessions.length, 2);
  assert.equal(after.sessions[0].endIndex, first.length - 1);
  assert.equal(after.sessions[0].slPrice, 111);
  assert.deepEqual(
    after.events.map((event) => event.type),
    ['Buy', 'Exit'],
  );
  assert.equal(after.events[1].index, first.length - 1);
  assert.equal(
    render([...first.slice(0, -1), bar(31, 111, 112, 110)]).sessions[0]
      .entryIndex,
    undefined,
  );
  assert.equal(render(first.slice(0, -1)).events.length, 0);
});

test('custom session begins once, crosses midnight and continues beyond its end until next start', () => {
  const nightStart = Date.parse('2026-10-27T21:00:00+08:00') / 1000;
  const data = [
    ...opening(),
    bar(330, 111, 112, 110),
    bar(331, 111, 112, 109),
  ].map((value) => ({ ...value, time: value.time - start + nightStart }));
  const result = render(data, {
    customSessionEnabled: true,
    customSessionStart: '21:00',
    customSessionEnd: '02:30',
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].startTime, nightStart);
  assert.equal(result.events[0].type, 'Buy');
  const morning = render(
    entry().map((value) => ({ ...value, time: value.time - 1800 })),
    { regularSessionStart: '09:00' },
  );
  assert.equal(morning.sessions.length, 1);
});

test('Pine simplified stats preserve exit ratios and even subtract a favorable forced-exit distance', () => {
  const result = render([
    ...entry(),
    bar(32, 115, 115, 114),
    { ...bar(0), time: start + 86400 },
  ]);
  const stats = orbStatistics(result.sessions, '90% | 5% | 5%');
  assert.equal(stats.losses, 1);
  near(stats.total, (-4 / 111) * 100);
  const winning = render(
    [
      ...opening(),
      bar(30, 111, 200, 104),
      bar(31, 112, 250, 90),
      bar(32, 113, 250, 90),
    ],
    { sensitivity: 'High', tpMethod: 'ATR' },
  );
  const w = orbStatistics(winning.sessions, '50% | 25% | 25%');
  const targets = winning.sessions[0].targets;
  near(
    w.total,
    targets.reduce(
      (sum, target, i) =>
        sum + ((target.price - 111) / 111) * 100 * [0.5, 0.25, 0.25][i],
      0,
    ),
  );
  assert.equal(w.wins, 1);
  assert.equal(w.winRate, 100);
  assert.equal(orbStatistics([], '90% | 5% | 5%').winRate, undefined);
});

test('history and display toggles preserve calculation; period limits and missing session warn', () => {
  const data = [
    ...entry(),
    ...entry()
      .slice(1)
      .map((value) => ({ ...value, time: value.time + 86400 })),
  ];
  const all = render(data);
  const latest = render(data, { showHistoricZones: false });
  assert.equal(
    all.drawings.filter((drawing) => drawing.kind === 'line').length,
    4,
  );
  assert.equal(
    latest.drawings.filter((drawing) => drawing.kind === 'line').length,
    2,
  );
  assert.deepEqual(latest.sessions, all.sessions);
  const hidden = render(data, {
    showORBZones: false,
    orbDisplayEnabled: false,
    backtestDisplayEnabled: false,
  });
  assert.equal(
    hidden.drawings.some((drawing) => drawing.kind === 'line'),
    false,
  );
  assert.deepEqual(hidden.dashboards, []);
  assert.equal(all.dashboards!.length, 2);
  for (const duration of [1800, 3600, 86400, 30]) {
    const result = render(data, {}, duration);
    assert.deepEqual(result.drawings, []);
    assert.deepEqual(result.dashboards, []);
    assert.match(result.warnings![0], /15 分钟/);
  }
  for (const duration of [60, 180, 300, 900])
    assert.equal(render([], {}, duration).warnings!.length, 0);
  assert.match(render(entry().slice(2)).warnings![0], /时段起点/);
});

test('plot budgets cap recent drawings without dropping historical sessions/statistics', () => {
  const data = [
    bar(-1),
    ...Array.from({ length: 300 }, (_, day) =>
      [0, 30].map((minute) => ({
        ...bar(
          minute,
          minute ? 111 : 105,
          minute ? 112 : 110,
          minute ? 110 : 100,
        ),
        time: start + day * 86400 + minute * 60,
      })),
    ).flat(),
  ];
  const result = render(data, { sensitivity: 'High' });
  assert.equal(result.sessions.length, 300);
  assert.ok(
    result.drawings.filter((drawing) => drawing.kind === 'line').length <= 500,
  );
  assert.ok(
    result.drawings.filter((drawing) => drawing.kind === 'label').length <= 500,
  );
  assert.equal(orbStatistics(result.sessions, '90% | 5% | 5%').days, 300);
});
