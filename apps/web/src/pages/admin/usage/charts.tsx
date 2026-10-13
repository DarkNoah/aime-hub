import { useTranslation } from 'react-i18next';
import type { UsageSummary, UsageQuery } from '@aime/shared/usage';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { dailySeries } from './format';

export function UsageCharts({
  data,
  query,
}: {
  data: UsageSummary;
  query: UsageQuery;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const compact = new Intl.NumberFormat(i18n.language, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const daily = dailySeries(data.daily, query);
  const maxDay = Math.max(1, ...daily.map((day) => day.totalTokens));
  return (
    <TooltipProvider>
      <div className="space-y-6">
        <section
          className="rounded-xl border bg-card p-5 sm:p-6"
          aria-label={t('usage.trend')}
        >
          <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">{t('usage.trend')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('usage.peak', {
                value: compact.format(
                  maxDay === 1 && !data.totals.totalTokens ? 0 : maxDay,
                ),
              })}
            </span>
          </div>
          <ScrollArea
            className="w-full overflow-hidden"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <div style={{ minWidth: Math.max(480, daily.length * 16) }}>
              <div
                className="flex h-44 items-end gap-1 border-b"
                aria-label={t('usage.trend')}
              >
                {daily.map((day) => (
                  <Tooltip key={day.date}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="group relative flex h-full min-w-0 flex-1 items-end rounded-t outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`${day.date}: ${number.format(day.totalTokens)} tokens, ${t('usage.stepsCount', { count: day.requests })}`}
                      >
                        <span
                          className="w-full rounded-t-sm bg-primary/75 transition-colors group-hover:bg-primary"
                          style={{
                            height: `${Math.max(day.totalTokens ? 1 : 0, (day.totalTokens / maxDay) * 100)}%`,
                          }}
                        />
                        {!day.totalTokens && (
                          <span className="absolute inset-x-0 bottom-0 h-px bg-muted-foreground/30" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-1">
                        <p>{day.date}</p>
                        <p>
                          {t('usage.totalTokens')}:{' '}
                          {number.format(day.totalTokens)}
                        </p>
                        <p>
                          {t('usage.inputTokens')}:{' '}
                          {number.format(day.inputTokens)} ·{' '}
                          {t('usage.outputTokens')}:{' '}
                          {number.format(day.outputTokens)}
                        </p>
                        <p>{t('usage.stepsCount', { count: day.requests })}</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
              <div className="flex justify-between pt-2 pb-3 text-xs text-muted-foreground">
                <span>{query.from}</span>
                <span>{query.to}</span>
              </div>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </section>
      </div>
    </TooltipProvider>
  );
}
