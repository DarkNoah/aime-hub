import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calendarGrid,
  dailySeries,
  monthGrid,
  monthRange,
  monthWindow,
} from './format.js';

test('monthly paging crosses years and includes leap days', () => {
  assert.deepEqual(monthRange('2026-01', -1), {
    from: '2025-12-01',
    to: '2025-12-31',
  });
  assert.deepEqual(monthRange('2026-12', 1), {
    from: '2027-01-01',
    to: '2027-01-31',
  });
  assert.deepEqual(monthRange('2024-02'), {
    from: '2024-02-01',
    to: '2024-02-29',
  });
  assert.deepEqual(monthRange('2025-02'), {
    from: '2025-02-01',
    to: '2025-02-28',
  });
  assert.deepEqual(monthRange('0099-12', 1), {
    from: '0100-01-01',
    to: '0100-01-31',
  });
});

test('month calendars include every day, align to Monday and leave outside dates blank', () => {
  const october = monthGrid([], '2026-10');
  assert.equal(october.length, 5);
  assert.deepEqual(october[0].slice(0, 3), [null, null, null]);
  assert.equal(october[0][3]?.date, '2026-10-01');
  assert.equal(october[4][5]?.date, '2026-10-31');
  assert.equal(october[4][6], null);
  for (const [month, count, weeks] of [
    ['2021-02', 28, 4],
    ['2024-02', 29, 5],
    ['2026-08', 31, 6],
  ] as const) {
    const grid = monthGrid([], month);
    const days = grid.flat().filter((day) => day !== null);
    assert.equal(grid.length, weeks);
    assert.equal(days.length, count);
    assert.equal(new Set(days.map((day) => day.date)).size, count);
    assert.ok(days.every((day) => day.totalTokens === 0 && day.requests === 0));
  }
});

test('calendar retains daily usage and discards records outside its displayed month', () => {
  const days = dailySeries([], { from: '2026-09-30', to: '2026-10-13' });
  days[0].totalTokens = 999;
  days.at(-1)!.totalTokens = 120;
  days.at(-1)!.requests = 2;
  const calendar = monthGrid(days, '2026-10');
  assert.equal(calendar[2][1]?.date, '2026-10-13');
  assert.equal(calendar[2][1]?.requests, 2);
  assert.equal(
    calendar.flat().reduce((sum, day) => sum + (day?.totalTokens ?? 0), 0),
    120,
  );
});

test('contribution windows cover consecutive full months and page without gaps', () => {
  const current = monthWindow('2026-10', 6);
  assert.deepEqual(current, { from: '2026-05-01', to: '2026-10-31' });
  assert.deepEqual(monthWindow('2026-10', 3), {
    from: '2026-08-01',
    to: '2026-10-31',
  });
  assert.deepEqual(monthWindow('2026-10', 12), {
    from: '2025-11-01',
    to: '2026-10-31',
  });
  const previous = monthWindow(monthRange('2026-10', -6).from.slice(0, 7), 6);
  const next = monthWindow(monthRange('2026-10', 6).from.slice(0, 7), 6);
  assert.equal(Date.parse(current.from) - Date.parse(previous.to), 86_400_000);
  assert.equal(Date.parse(next.from) - Date.parse(current.to), 86_400_000);
  const weeks = calendarGrid([], current);
  const dates = weeks
    .flat()
    .filter((day) => day !== null)
    .map((day) => day.date);
  assert.equal(dates.length, 184);
  assert.equal(new Set(dates).size, 184);
  assert.equal(weeks.length, 27);
  assert.equal(weeks[9][1]?.date, '2026-06-30');
  assert.equal(weeks[9][2]?.date, '2026-07-01');
  const leapYear = calendarGrid([], monthWindow('2024-12', 12))
    .flat()
    .filter((day) => day !== null);
  assert.equal(leapYear.length, 366);
  assert.ok(leapYear.some((day) => day.date === '2024-02-29'));
});
