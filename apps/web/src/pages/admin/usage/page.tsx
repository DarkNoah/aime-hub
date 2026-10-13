import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  usageQuerySchema,
  type UsageQuery,
  type UsageSummary,
} from '@aime/shared/usage';
import { api } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { UsageCharts } from './charts';
import { UsageHeatmap } from './heatmap';
import { UsageBreakdown } from './breakdown';
import { UsageRecords } from './records';
import { dateRange } from './format';

function initialQuery(): UsageQuery {
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  return { ...dateRange(30, timezone), timezone };
}

export function AdminUsagePage() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [draft, setDraft] = useState(query);
  const [invalid, setInvalid] = useState(false);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    queryKey: string;
    data?: UsageSummary;
    error?: boolean;
  }>();
  const queryKey = JSON.stringify(query);
  const key = `${queryKey}:${revision}`;
  const loading = result?.key !== key;
  const data = result?.queryKey === queryKey ? result.data : undefined;
  const number = new Intl.NumberFormat(i18n.language);
  const zones = [
    ...new Set([
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      'Asia/Shanghai',
      'UTC',
      'America/New_York',
      'Europe/London',
    ]),
  ];

  useEffect(() => {
    const controller = new AbortController();
    void api.usage.summary({ query }, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, queryKey, data });
      },
      () => {
        if (!controller.signal.aborted) {
          setResult({ key, queryKey, error: true });
          toast.error(t('usage.loadError'));
        }
      },
    );
    return () => controller.abort();
  }, [key, queryKey, query, t]);

  function apply(next: UsageQuery) {
    const parsed = usageQuerySchema.safeParse(next);
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    setDraft(parsed.data);
    setQuery(parsed.data);
    setRevision((value) => value + 1);
  }
  const filterFields = ['userId', 'projectId', 'providerId', 'model'] as const;
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.usage')}
        description={t('usage.description')}
        actions={
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw
              className={loading ? 'motion-safe:animate-spin' : undefined}
            />
            {t('usage.refresh')}
          </Button>
        }
      />
      <form
        className="space-y-4 rounded-xl border bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault();
          apply(draft);
        }}
      >
        <div className="flex flex-wrap gap-2">
          {[7, 30, 90].map((days) => (
            <Button
              key={days}
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                apply({ ...draft, ...dateRange(days, draft.timezone) })
              }
            >
              {t('usage.lastDays', { days })}
            </Button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(['from', 'to'] as const).map((field) => (
            <div className="min-w-0 space-y-2" key={field}>
              <Label htmlFor={`usage-${field}`}>{t(`usage.${field}`)}</Label>
              <Input
                id={`usage-${field}`}
                type="date"
                required
                value={draft[field]}
                aria-invalid={invalid}
                aria-describedby={invalid ? 'usage-date-error' : undefined}
                onChange={(event) =>
                  setDraft({ ...draft, [field]: event.target.value })
                }
              />
            </div>
          ))}
          <div className="space-y-2">
            <Label htmlFor="usage-timezone">{t('usage.timezone')}</Label>
            <Select
              value={draft.timezone}
              onValueChange={(timezone) => setDraft({ ...draft, timezone })}
            >
              <SelectTrigger id="usage-timezone" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((zone) => (
                  <SelectItem value={zone} key={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit">{t('usage.apply')}</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => apply(initialQuery())}
            >
              {t('usage.reset')}
            </Button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filterFields.map((field) => {
            const choices =
              field === 'userId'
                ? data?.users
                : field === 'projectId'
                  ? data?.projects
                  : data?.models;
            const options = [
              ...new Map(
                (choices ?? []).map((item) => {
                  const id = field === 'providerId' ? item.providerId : item.id;
                  const label =
                    field === 'providerId' ? item.providerName : item.name;
                  return [
                    id ?? '__none__',
                    {
                      id: id ?? '__none__',
                      label:
                        label ??
                        (field === 'projectId'
                          ? t('usage.personal')
                          : t('usage.unknown')),
                    },
                  ];
                }),
              ).values(),
            ];
            return (
              <div key={field} className="min-w-0 space-y-2">
                <Label htmlFor={`usage-${field}`}>{t(`usage.${field}`)}</Label>
                <Input
                  id={`usage-${field}`}
                  list={`usage-${field}-options`}
                  value={draft[field] ?? ''}
                  maxLength={200}
                  placeholder={t('usage.filterHint')}
                  onChange={(event) =>
                    setDraft({ ...draft, [field]: event.target.value })
                  }
                />
                <datalist id={`usage-${field}-options`}>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </datalist>
              </div>
            );
          })}
        </div>
        {invalid && (
          <p
            id="usage-date-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {t('usage.invalidDates')}
          </p>
        )}
      </form>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{t('usage.runtime')}</Badge>
        <span>
          {query.from} – {query.to} · {query.timezone}
        </span>
        <span>{t('usage.scopeHint')}</span>
      </div>
      {!loading && result?.error ? (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-destructive/25 p-5 text-sm text-destructive"
        >
          {t('usage.loadError')}
          <Button
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('requestLogs.retry')}
          </Button>
        </div>
      ) : !data ? (
        <LoadingState />
      ) : (
        <div className="space-y-6" aria-busy={loading}>
          <section
            className="rounded-xl border bg-card"
            aria-label={t('usage.summary')}
          >
            <dl className="grid grid-cols-2 divide-x divide-y sm:grid-cols-4 sm:divide-y-0">
              {(
                [
                  'totalTokens',
                  'inputTokens',
                  'outputTokens',
                  'requests',
                ] as const
              ).map((field) => (
                <div key={field} className="p-5">
                  <dt className="text-sm text-muted-foreground">
                    {t(`usage.${field}`)}
                  </dt>
                  <dd className="mt-2 text-2xl font-semibold tabular-nums">
                    {number.format(data.totals[field])}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t px-5 py-3 text-xs text-muted-foreground">
              {(
                [
                  'cachedInputTokens',
                  'cacheCreationInputTokens',
                  'reasoningTokens',
                ] as const
              ).map((field) => (
                <span key={field}>
                  {t(`usage.${field}`)}{' '}
                  <strong className="font-medium text-foreground tabular-nums">
                    {number.format(data.totals[field])}
                  </strong>
                </span>
              ))}
              <span>
                {t('usage.coverage', {
                  known: number.format(data.totals.reportedRequests),
                  total: number.format(data.totals.requests),
                })}
              </span>
            </div>
          </section>
          {!data.totals.requests ? (
            <div className="rounded-xl border border-dashed px-6 py-12 text-center">
              <BarChart3 className="mx-auto mb-3 size-7 text-muted-foreground" />
              <h2 className="font-medium">{t('usage.empty')}</h2>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
                {t('usage.emptyHint')}
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('usage.tokenHint')}
              </p>
              <UsageCharts data={data} query={query} />
              <UsageBreakdown
                data={data}
                onFilter={(patch) => apply({ ...query, ...patch })}
              />
            </>
          )}
        </div>
      )}
      <UsageHeatmap
        key={query.to.slice(0, 7)}
        query={query}
        revision={revision}
      />
      <UsageRecords key={queryKey} query={query} revision={revision} />
    </div>
  );
}
