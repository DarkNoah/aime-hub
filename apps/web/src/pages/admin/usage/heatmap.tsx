import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { HeatMap, type CellComponentProps } from '@nivo/heatmap';
import type { UsageBucket, UsageQuery, UsageSummary } from '@aime/shared/usage';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading-state';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { calendarGrid, dateRange, monthRange, monthWindow } from './format';

const colors = [
  'var(--muted)',
  'color-mix(in oklab, var(--primary) 20%, var(--card))',
  'color-mix(in oklab, var(--primary) 40%, var(--card))',
  'color-mix(in oklab, var(--primary) 65%, var(--card))',
  'var(--primary)',
];
const theme = {
  text: { fill: 'var(--muted-foreground)', fontSize: 10 },
  axis: { ticks: { text: { fill: 'var(--muted-foreground)' } } },
};
type HeatmapDatum = {
  x: string;
  y: number | null;
  day: UsageBucket | null;
  level: number;
  label: string;
};

// Nivo supplies calendar geometry; Radix keeps details keyboard accessible and portalled.
function HeatmapCell({ cell }: CellComponentProps<HeatmapDatum>) {
  const { t, i18n } = useTranslation();
  const day = cell.data.day;
  if (!day) return null;
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <g
          tabIndex={0}
          role="img"
          aria-label={cell.data.label}
          className="group outline-none"
        >
          <rect
            x={cell.x - cell.width / 2}
            y={cell.y - cell.height / 2}
            width={cell.width}
            height={cell.height}
            rx={2}
            fill={cell.color}
            stroke="transparent"
            strokeWidth={1}
            className="group-hover:stroke-foreground group-focus-visible:stroke-ring"
          />
        </g>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>
        <div className="space-y-1">
          <p>{day.date}</p>
          <p>
            {t('usage.totalTokens')}: {number.format(day.totalTokens)}
          </p>
          <p>
            {t('usage.inputTokens')}: {number.format(day.inputTokens)} ·{' '}
            {t('usage.outputTokens')}: {number.format(day.outputTokens)}
          </p>
          <p>{t('usage.stepsCount', { count: day.requests })}</p>
          {day.reportedRequests < day.requests && (
            <p>
              {t('usage.coverage', {
                known: day.reportedRequests,
                total: day.requests,
              })}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function UsageHeatmap({
  query,
  revision,
}: {
  query: UsageQuery;
  revision: number;
}) {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(query.to.slice(0, 7));
  const [months, setMonths] = useState(12);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: UsageSummary;
    error?: boolean;
  }>();
  const calendarQuery = useMemo(
    () => ({
      ...monthWindow(month, months),
      timezone: query.timezone,
      userId: query.userId,
      projectId: query.projectId,
      providerId: query.providerId,
      model: query.model,
    }),
    [
      month,
      months,
      query.timezone,
      query.userId,
      query.projectId,
      query.providerId,
      query.model,
    ],
  );
  const key = `${JSON.stringify(calendarQuery)}:${revision}:${retry}`;
  const loading = result?.key !== key;
  const data = !loading ? result?.data : undefined;
  const currentMonth = dateRange(1, query.timezone).to.slice(0, 7);
  const title = `${calendarQuery.from.slice(0, 7)} – ${calendarQuery.to.slice(0, 7)}`;

  useEffect(() => {
    const controller = new AbortController();
    void api.usage
      .summary({ query: calendarQuery }, { signal: controller.signal })
      .then(
        (data) => {
          if (!controller.signal.aborted) setResult({ key, data });
        },
        () => {
          if (!controller.signal.aborted) {
            setResult({ key, error: true });
            toast.error(t('usage.loadError'));
          }
        },
      );
    return () => controller.abort();
  }, [key, calendarQuery, t]);

  const series = useMemo(() => {
    const number = new Intl.NumberFormat(i18n.language);
    const weekday = new Intl.DateTimeFormat(i18n.language, {
      weekday: 'short',
      timeZone: 'UTC',
    });
    const max = Math.max(
      1,
      ...(data?.daily ?? []).map((day) => day.totalTokens),
    );
    const weeks = calendarGrid(data?.daily ?? [], calendarQuery);
    return Array.from({ length: 7 }, (_, weekdayIndex) => ({
      id: weekday.format(new Date(Date.UTC(2026, 0, 5 + weekdayIndex))),
      data: weeks.map((week, index) => {
        const day = week[weekdayIndex];
        return {
          x: String(index),
          y: day?.totalTokens ?? null,
          day,
          level: day?.totalTokens
            ? Math.min(4, Math.ceil((day.totalTokens / max) * 4))
            : 0,
          label: day
            ? `${day.date} · ${number.format(day.totalTokens)} tokens · ${t('usage.stepsCount', { count: day.requests })}`
            : '',
        };
      }),
    }));
  }, [data, calendarQuery, i18n.language, t]);
  const chartWidth = series[0].data.length * 18 + 34;
  const monthLabels = new Map<string, string>();
  const monthLabel = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    timeZone: 'UTC',
  });
  for (const row of series) {
    for (const cell of row.data) {
      if (cell.day?.date.endsWith('-01')) {
        monthLabels.set(cell.x, monthLabel.format(new Date(cell.day.date)));
      }
    }
  }
  const monthTicks = [...monthLabels.keys()].sort(
    (a, b) => Number(a) - Number(b),
  );

  return (
    <section
      className="w-full rounded-xl border bg-card p-5 sm:p-6"
      aria-label={t('usage.heatmap')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">{t('usage.heatmap')}</h2>
          <Select
            value={String(months)}
            onValueChange={(value) => setMonths(Number(value))}
          >
            <SelectTrigger
              className="h-8 w-28"
              aria-label={t('usage.visibleMonths')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3, 6, 12].map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {t('usage.monthCount', { count })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('usage.previousPeriod', { months })}
            disabled={
              calendarQuery.from.slice(0, 7) <
              `0001-${String(months + 1).padStart(2, '0')}`
            }
            onClick={() =>
              setMonth(monthRange(month, -months).from.slice(0, 7))
            }
          >
            <ChevronLeft />
          </Button>
          <span
            className="text-center text-sm font-medium tabular-nums"
            aria-live="polite"
          >
            {title}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('usage.nextPeriod', { months })}
            disabled={month > `9999-${String(12 - months).padStart(2, '0')}`}
            onClick={() => setMonth(monthRange(month, months).from.slice(0, 7))}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={month === currentMonth}
            onClick={() => setMonth(currentMonth)}
          >
            {t('usage.recentPeriod')}
          </Button>
        </div>
      </div>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        {t('usage.heatmapHint', { months, timezone: query.timezone })}
      </p>
      <div className="min-h-40" aria-busy={loading}>
        {loading ? (
          <LoadingState />
        ) : result?.error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 py-8 text-sm text-destructive"
          >
            {t('usage.loadError')}
            <Button
              variant="outline"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('requestLogs.retry')}
            </Button>
          </div>
        ) : (
          <TooltipProvider>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
              <ScrollArea
                className="min-w-0 max-w-full flex-1 basis-72 overflow-hidden"
                viewportProps={{ className: '[&>div]:block!' }}
              >
                <div style={{ width: chartWidth }} className="pb-3">
                  <HeatMap<HeatmapDatum, object>
                    width={chartWidth}
                    height={154}
                    data={series}
                    margin={{ top: 26, right: 2, bottom: 2, left: 32 }}
                    axisTop={{
                      tickSize: 0,
                      tickPadding: 10,
                      tickValues: monthTicks,
                      format: (value) => monthLabels.get(String(value)) ?? '',
                    }}
                    axisLeft={{
                      tickSize: 0,
                      tickPadding: 6,
                      tickValues: [series[0].id, series[2].id, series[4].id],
                    }}
                    axisBottom={null}
                    axisRight={null}
                    xInnerPadding={0.2}
                    yInnerPadding={0.2}
                    colors={({ data }) => colors[data.level]}
                    theme={theme}
                    cellComponent={HeatmapCell}
                    enableLabels={false}
                    isInteractive={false}
                    animate={false}
                    role="group"
                    ariaLabel={`${t('usage.heatmap')} · ${title}`}
                  />
                </div>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
              <dl className="flex shrink-0 flex-wrap gap-x-8 gap-y-3">
                {(['totalTokens', 'requests'] as const).map((field) => (
                  <div key={field}>
                    <dt className="text-xs text-muted-foreground">
                      {t(`usage.${field}`)}
                    </dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums">
                      {new Intl.NumberFormat(i18n.language).format(
                        data?.totals[field] ?? 0,
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </TooltipProvider>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {!loading && data?.totals.requests === 0
            ? t('usage.emptyPeriod')
            : `${calendarQuery.from} – ${calendarQuery.to}`}
        </span>
        <div className="flex items-center gap-1.5">
          <span>{t('usage.less')}</span>
          {colors.map((color) => (
            <span
              key={color}
              className="size-3 rounded-sm"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
          ))}
          <span>{t('usage.more')}</span>
        </div>
      </div>
    </section>
  );
}
