import type { UsageBucket, UsageQuery } from '@aime/shared/usage';

export function dateRange(days: number, timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: string) =>
    parts.find((item) => item.type === name)!.value;
  const to = `${part('year')}-${part('month')}-${part('day')}`;
  const from = new Date(Date.parse(to) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

export function dailySeries(
  data: UsageBucket[],
  query: Pick<UsageQuery, 'from' | 'to'>,
) {
  const indexed = new Map(data.map((item) => [item.date, item]));
  const points = [];
  for (
    let time = Date.parse(query.from);
    time <= Date.parse(query.to);
    time += 86_400_000
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    points.push(
      indexed.get(date) ?? {
        date,
        requests: 0,
        reportedRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        averageDurationMs: null,
      },
    );
  }
  return points;
}

export function monthRange(month: string, offset = 0) {
  const first = new Date(`${month}-01T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + offset);
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return {
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
  };
}

export function monthGrid(data: UsageBucket[], month: string) {
  return calendarGrid(data, monthRange(month));
}

export function monthWindow(endMonth: string, months: number) {
  return {
    from: monthRange(endMonth, 1 - months).from,
    to: monthRange(endMonth).to,
  };
}

export function calendarGrid(
  data: UsageBucket[],
  range: Pick<UsageQuery, 'from' | 'to'>,
) {
  const days = dailySeries(data, range);
  const leading = (new Date(range.from).getUTCDay() + 6) % 7;
  return Array.from(
    { length: Math.ceil((leading + days.length) / 7) },
    (_, week) =>
      Array.from(
        { length: 7 },
        (_, weekday) => days[week * 7 + weekday - leading] ?? null,
      ),
  );
}
