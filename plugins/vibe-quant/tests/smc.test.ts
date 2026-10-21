import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bar } from '../shared';
type Candle = Bar & { isFinal?: boolean };
import { calculateSmc } from '../web/indicators/main/smc/engine';
import {
  DEFAULT_SMC_SETTINGS,
  SMC_FIELDS,
} from '../web/indicators/main/smc/settings';
import { smcBucket } from '../web/indicators/main/smc/engine';
import { smcIndicator } from '../web/indicators/main/smc';
import {
  defaultParameters,
  parsePreferences,
  validateParameters,
} from '../web/indicators/preferences';
import { DURATIONS } from '../shared';
const bar = (
  index: number,
  close: number,
  high = close + 1,
  low = close - 1,
): Candle => ({
  symbol: 'TEST',
  duration: 60,
  time: 1_700_000_040 + index * 60,
  open: close,
  close,
  high,
  low,
  volume: 1,
  amount: close,
  isFinal: true,
});
const base = () => [
  bar(0, 5.5, 6, 5),
  ...Array.from({ length: 10 }, (_, i) => bar(i + 1, 10)),
  bar(11, 19, 20, 18),
  ...Array.from({ length: 10 }, (_, i) => bar(i + 12, 10)),
];
const config = {
  swingsLengthInput: 10,
  showInternalsInput: false,
  showInternalOrderBlocksInput: false,
  showSwingOrderBlocksInput: true,
};

test('start timestamps use Shanghai calendar boundaries without a second close-time offset', () => {
  const local = (date: string) => Date.parse(date + '+08:00') / 1000;
  const midnight = local('2026-10-01T00:00:00');
  assert.equal(smcBucket(midnight, '1d'), midnight);
  assert.equal(smcBucket(midnight - 1, '1M'), local('2026-09-01T00:00:00'));
  assert.equal(smcBucket(midnight, '1M'), midnight);
  assert.equal(
    smcBucket(local('2026-10-05T00:00:00'), '1w'),
    local('2026-10-05T00:00:00'),
  );
  assert.equal(
    smcBucket(local('2026-10-21T09:35:00'), '5m'),
    local('2026-10-21T09:35:00'),
  );
});

test('registration supports every chart period, empty windows and persisted alpha colors', () => {
  const parameters = defaultParameters(smcIndicator);
  assert.equal(validateParameters(smcIndicator, parameters), undefined);
  const settings = parsePreferences(
    JSON.stringify({
      smc: {
        visible: false,
        parameters: {
          ...parameters,
          internalBullishOrderBlockColor: '#12345680',
          swingsLengthInput: 30,
          fairValueGapsTimeframeInput: '3m',
        },
      },
    }),
  );
  assert.equal(settings.smc.visible, false);
  assert.equal(
    settings.smc.parameters.internalBullishOrderBlockColor,
    '#12345680',
  );
  assert.equal(settings.smc.parameters.swingsLengthInput, 30);
  assert.equal(settings.smc.parameters.fairValueGapsTimeframeInput, '3m');
  assert.equal(parsePreferences('{"ma":{"visible":false}}').ma.visible, false);
  assert.equal(parsePreferences('{"ma":{"visible":false}}').smc.visible, true);
  for (const duration of DURATIONS) {
    const data = base().map((bar, index) => ({
      ...bar,
      duration,
      time: Date.parse('2026-01-01T00:00:00+08:00') / 1000 + index * duration,
    }));
    const result = smcIndicator.renderOverlay!(data, parameters, duration);
    assert.ok(
      result.drawings.every((d) =>
        [d.from, d.to, d.top, d.bottom].every(Number.isFinite),
      ),
    );
    assert.deepEqual(
      smcIndicator.renderOverlay!([], parameters, duration).drawings,
      [],
    );
  }
  assert.ok(
    validateParameters(smcIndicator, { ...parameters, swingsLengthInput: 2.5 }),
  );
  assert.ok(
    validateParameters(smcIndicator, {
      ...parameters,
      internalBullishOrderBlockColor: 'red',
    }),
  );
});

test('coarse monthly bars never fabricate daily or weekly high/low levels', () => {
  const result = calculateSmc(
    base(),
    { showDailyLevelsInput: true, showWeeklyLevelsInput: true },
    '1M',
  );
  assert.equal(
    result.drawings.some((d) =>
      ['PDH', 'PDL', 'PWH', 'PWL'].includes(d.text ?? ''),
    ),
    false,
  );
  assert.equal(
    result.warnings.filter((w) => w.includes('小于图表周期')).length,
    2,
  );
});

test('all 52 reference inputs keep their defaults', () => {
  assert.equal(Object.keys(SMC_FIELDS).length, 52);
  assert.equal(DEFAULT_SMC_SETTINGS.swingsLengthInput, 50);
  assert.equal(DEFAULT_SMC_SETTINGS.internalOrderBlocksSizeInput, 5);
  assert.equal(
    DEFAULT_SMC_SETTINGS.internalBullishOrderBlockColor,
    '#3179f533',
  );
});
test('pivot confirmation, close crossing, exact endpoints and CHoCH trend reversal', () => {
  const bars = [...base(), bar(22, 21), bar(23, 4)];
  const r = calculateSmc(bars, config);
  assert.deepEqual(
    r.events
      .filter((e) => e.type.startsWith('swing'))
      .map((e) => [e.index, e.type]),
    [
      [22, 'swingBullishBOS'],
      [23, 'swingBearishCHoCH'],
      [23, 'swingBullishOrderBlock'],
    ],
  );
  const bos = r.drawings.find((d) => d.text === 'BOS')!;
  assert.deepEqual(
    [bos.from, bos.to, bos.top, bos.labelIndex, bos.color, bos.style],
    [11, 22, 20, 17, '#089981', 'solid'],
  );
  const choch = r.drawings.find((d) => d.text === 'CHoCH')!;
  assert.deepEqual(
    [choch.from, choch.to, choch.top, choch.labelIndex, choch.color],
    [0, 23, 5, 12, '#F23645'],
  );
  // Strong/weak drawing is executed before this bar changes the bullish trend.
  assert.equal(
    r.drawings.find((d) => d.id === 'strongLow')?.text,
    'Strong Low',
  );
  assert.equal(r.swingBias, -1);
});
test('wicks and equality do not trigger close crossovers; a pivot crosses only once', () => {
  const wick = calculateSmc([...base(), bar(22, 20, 25, 19)], config);
  assert.equal(
    wick.events.filter((e) => e.type === 'swingBullishBOS').length,
    0,
  );
  const repeated = calculateSmc(
    [...base(), bar(22, 21), bar(23, 19), bar(24, 22)],
    config,
  );
  assert.equal(
    repeated.events.filter((e) => e.type === 'swingBullishBOS').length,
    1,
  );
});
test('order block excludes the breakout bar, selects first minimum and extends right', () => {
  const r = calculateSmc([...base(), bar(22, 21, 23, 8)], config);
  // Low 8 mitigates the newly stored low-9 block on the same bar.
  assert.equal(r.drawings.filter((d) => d.id.startsWith('swing-ob')).length, 0);
  const safe = calculateSmc([...base(), bar(22, 21)], config);
  const ob = safe.drawings.find((d) => d.id === 'swing-ob-0')!;
  assert.deepEqual(
    [ob.from, ob.top, ob.bottom, ob.color, ob.extendRight],
    [12, 11, 9, '#1848cc33', true],
  );
});
test('replacing the live candle withdraws events and boxes without mutating historical input', () => {
  const bars = [...base(), { ...bar(22, 21), isFinal: false }];
  const snapshot = JSON.stringify(bars);
  const first = calculateSmc(bars, config);
  assert.equal(
    first.events.find((e) => e.type === 'swingBullishBOS')?.provisional,
    true,
  );
  const corrected = [
    ...bars.slice(0, -1),
    { ...bar(22, 19, 22, 18), isFinal: false },
  ];
  const second = calculateSmc(corrected, config);
  assert.equal(
    second.events.some((e) => e.type === 'swingBullishBOS'),
    false,
  );
  assert.equal(
    second.drawings.some((d) => d.id.startsWith('swing-ob')),
    false,
  );
  assert.equal(JSON.stringify(bars), snapshot);
  assert.deepEqual(calculateSmc(bars, config), first);
});
test('EQH/EQL require ATR200 and use confirmation-bar ATR and pivot coordinates', () => {
  const make = (offset: number) => [
    bar(offset, 5, 6, 4),
    ...[1, 2, 3].map((i) => bar(offset + i, 10)),
    bar(offset + 4, 19, 20, 18),
    ...[5, 6, 7].map((i) => bar(offset + i, 10)),
    bar(offset + 8, 5.01, 6, 4.01),
    ...[9, 10, 11].map((i) => bar(offset + i, 10)),
    bar(offset + 12, 19, 20.01, 18),
    ...[13, 14, 15].map((i) => bar(offset + i, 10)),
  ];
  assert.equal(
    calculateSmc(make(0)).drawings.some((d) => d.text === 'EQL'),
    false,
  );
  const r = calculateSmc([
    ...Array.from({ length: 200 }, (_, i) => bar(i, 10)),
    ...make(200),
  ]);
  const eql = r.drawings.find((d) => d.text === 'EQL')!;
  assert.deepEqual(
    [eql.from, eql.to, eql.top, eql.bottom, eql.labelIndex, eql.style],
    [200, 208, 4, 4.01, 204, 'dotted'],
  );
  assert.equal(r.events.find((e) => e.type === 'equalLows')?.index, 211);
  assert.equal(r.events.find((e) => e.type === 'equalHighs')?.index, 215);
});
test('same timeframe FVG makes two fixed boxes and strict mitigation deletes them', () => {
  const bars = [
    bar(0, 10, 11, 9),
    { ...bar(1, 14, 15, 12), open: 12 },
    bar(2, 17, 18, 16),
  ];
  const cfg = {
    showFairValueGapsInput: true,
    fairValueGapsThresholdInput: false,
  };
  const r = calculateSmc(bars, cfg);
  const gaps = r.drawings.filter((d) => d.id.startsWith('fvg'));
  assert.equal(gaps.length, 2);
  assert.deepEqual(
    gaps.map((d) => [d.from, d.to, d.top, d.bottom]),
    [
      [1, 3, 16, 13.5],
      [1, 3, 13.5, 11],
    ],
  );
  assert.equal(r.events.at(-1)?.type, 'bullishFairValueGap');
  assert.equal(
    calculateSmc([...bars, bar(3, 12, 13, 11)], cfg).drawings.filter((d) =>
      d.id.startsWith('fvg'),
    ).length,
    2,
  );
  assert.equal(
    calculateSmc([...bars, bar(3, 10, 12, 10)], cfg).drawings.filter((d) =>
      d.id.startsWith('fvg'),
    ).length,
    0,
  );
});
test('monochrome, toggles and independently scoped Present objects', () => {
  const r = calculateSmc([...base(), bar(22, 21), bar(23, 4)], {
    ...config,
    modeInput: 'Present',
    styleInput: 'Monochrome',
  });
  assert.deepEqual(
    r.drawings
      .filter((d) => d.text === 'BOS' || d.text === 'CHoCH')
      .map((d) => d.color),
    ['#b2b5be', '#5d606b'],
  );
  const hidden = calculateSmc([...base(), bar(22, 21)], {
    ...config,
    showStructureInput: false,
    showSwingOrderBlocksInput: false,
    showHighLowSwingsInput: false,
  });
  assert.equal(hidden.drawings.length, 0);
});
test('unsupported lower timeframe is visible as a warning, not substituted', () => {
  const r = calculateSmc(
    base(),
    { showFairValueGapsInput: true, fairValueGapsTimeframeInput: '1m' },
    '5m',
  );
  assert.ok(r.warnings.some((w) => w.includes('小于')));
  assert.equal(r.drawings.filter((d) => d.id.startsWith('fvg')).length, 0);
});
test('daily context supplies previous month prices outside the minute history window', () => {
  const daily = [
    { ...bar(0, 100, 110, 90), time: Date.UTC(2026, 6, 1, 15) / 1000 },
    { ...bar(1, 200, 250, 180), time: Date.UTC(2026, 7, 3, 15) / 1000 },
    { ...bar(2, 210, 260, 170), time: Date.UTC(2026, 7, 31, 15) / 1000 },
    { ...bar(3, 220, 230, 210), time: Date.UTC(2026, 8, 7, 15) / 1000 },
  ];
  const minutes = [
    { ...bar(0, 220, 230, 210), time: Date.UTC(2026, 8, 7, 9, 31) / 1000 },
    { ...bar(1, 221), time: Date.UTC(2026, 8, 7, 9, 32) / 1000 },
  ];
  const result = calculateSmc(minutes, { showMonthlyLevelsInput: true }, '1m', {
    dailyBars: daily,
  });
  assert.equal(result.drawings.find((d) => d.text === 'PMH')?.top, 260);
  assert.equal(result.drawings.find((d) => d.text === 'PML')?.top, 170);
  assert.equal(result.drawings.find((d) => d.text === 'PMH')?.from, 0);
  // A daily row later than the displayed chart date must never enter the calculation.
  assert.deepEqual(
    calculateSmc(minutes, { showMonthlyLevelsInput: true }, '1m', {
      dailyBars: [
        ...daily,
        { ...daily[0], time: Date.UTC(2026, 9, 1, 15) / 1000, high: 99999 },
      ],
    }),
    result,
  );
});
test('daily-context FVG coordinates stay finite even when preceding buckets are off-screen', () => {
  const daily = Array.from({ length: 6 }, (_, i) => ({
    ...bar(i, 100 + i * 10),
    open: 95 + i * 10,
    time: Date.UTC(2026, 8, i + 1, 15) / 1000,
  }));
  const minutes = [0, 1, 2].map((i) => ({
    ...bar(i, 160),
    time: Date.UTC(2026, 8, 7, 9, 31 + i) / 1000,
  }));
  const r = calculateSmc(
    minutes,
    {
      showFairValueGapsInput: true,
      fairValueGapsTimeframeInput: '1d',
      fairValueGapsThresholdInput: false,
    },
    '1m',
    { dailyBars: daily },
  );
  assert.equal(r.drawings.filter((d) => d.id.startsWith('fvg')).length, 2);
  assert.ok(
    r.drawings.every((d) => Number.isFinite(d.from) && Number.isFinite(d.to)),
  );
});
