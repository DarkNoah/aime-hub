import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import type {
  UsageQuery,
  UsageRecord,
  UsageRecordPage,
  UsageRecordsQuery,
} from '@aime/shared/usage';
import { tokenFields } from '@aime/shared/usage';
import { api } from '@/lib/rpc';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { LoadingState } from '@/components/loading-state';

export function UsageRecords({
  query,
  revision,
}: {
  query: UsageQuery;
  revision: number;
}) {
  const { t, i18n } = useTranslation();
  const [cursors, setCursors] = useState<UsageRecordsQuery['cursor'][]>([
    undefined,
  ]);
  const [result, setResult] = useState<{
    key: string;
    data?: UsageRecordPage;
    error?: boolean;
  }>();
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<UsageRecord>();
  const [retry, setRetry] = useState(0);
  const cursor = cursors.at(-1);
  const key = JSON.stringify([query, cursor, revision, retry]);
  const loading = result?.key !== key;
  const number = new Intl.NumberFormat(i18n.language);
  const date = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: query.timezone,
  });
  const value = (count: number | null) =>
    count === null ? '—' : number.format(count);
  useEffect(() => {
    const controller = new AbortController();
    void api.usage
      .records(
        { query: { ...query, cursor, limit: 30 } },
        { signal: controller.signal },
      )
      .then(
        (data) => {
          if (!controller.signal.aborted) setResult({ key, data });
        },
        () => {
          if (!controller.signal.aborted) setResult({ key, error: true });
        },
      );
    return () => controller.abort();
  }, [key, query, cursor]);
  return (
    <section
      className="min-w-0 rounded-xl border bg-card p-5 sm:p-6"
      aria-busy={loading}
    >
      <h2 className="font-semibold">{t('usage.records')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('usage.recordsHint')}
      </p>
      {loading && !result?.data ? (
        <LoadingState />
      ) : !loading && result?.error ? (
        <div
          role="alert"
          className="flex items-center gap-3 py-6 text-sm text-destructive"
        >
          {t('usage.loadError')}
          <Button
            variant="outline"
            onClick={() => setRetry((count) => count + 1)}
          >
            {t('requestLogs.retry')}
          </Button>
        </div>
      ) : (
        <ScrollArea className="mt-4 w-full overflow-hidden">
          <table className="w-full min-w-[950px] text-sm">
            <thead className="text-muted-foreground">
              <tr>
                {(
                  [
                    'time',
                    'user',
                    'project',
                    'model',
                    'inputTokens',
                    'outputTokens',
                    'totalTokens',
                    'status',
                  ] as const
                ).map((field) => (
                  <th
                    key={field}
                    className={`px-3 py-3 font-medium ${field.endsWith('Tokens') ? 'text-right' : 'text-left'}`}
                  >
                    {t(`usage.${field}`)}
                  </th>
                ))}
                <th className="px-3">
                  <span className="sr-only">{t('usage.details')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {result?.data?.items.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-3 whitespace-nowrap text-xs tabular-nums">
                    {date.format(new Date(row.createdAt))}
                  </td>
                  <td
                    className="max-w-36 truncate px-3 py-3"
                    title={row.userId ?? undefined}
                  >
                    {row.userName ?? row.userId ?? t('usage.unknown')}
                  </td>
                  <td
                    className="max-w-36 truncate px-3 py-3"
                    title={row.projectId ?? undefined}
                  >
                    {row.projectName ?? row.projectId ?? t('usage.personal')}
                  </td>
                  <td className="max-w-56 px-3 py-3">
                    <p className="truncate" title={row.model ?? undefined}>
                      {row.model}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.providerName ??
                        row.providerId ??
                        t('usage.unknownProvider')}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {value(row.inputTokens)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {value(row.outputTokens)}
                  </td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums">
                    {value(row.totalTokens)}
                  </td>
                  <td className="px-3 py-3">
                    <Badge
                      variant={
                        row.totalTokens === null ? 'outline' : 'secondary'
                      }
                    >
                      {t(
                        row.totalTokens === null
                          ? 'usage.unreported'
                          : 'usage.reported',
                      )}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(event) => {
                        detailTrigger.current = event.currentTarget;
                        setSelected(row);
                      }}
                      aria-label={t('usage.detailsNamed', {
                        model: row.model ?? '',
                        time: date.format(new Date(row.createdAt)),
                      })}
                    >
                      <MoreHorizontal />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!result?.data?.items.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('usage.noRecords')}
            </p>
          )}
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}
      <div className="mt-4 flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">
          {t('usage.page', { page: cursors.length })}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('usage.previous')}
          disabled={loading || cursors.length === 1}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('usage.next')}
          disabled={loading || !result?.data?.nextCursor}
          onClick={() =>
            setCursors((current) => [
              ...current,
              result?.data?.nextCursor ?? undefined,
            ])
          }
        >
          <ChevronRight />
        </Button>
      </div>
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <SheetContent
          className="w-full sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            detailTrigger.current?.focus();
          }}
        >
          <div className="px-6 pt-6 pr-12">
            <SheetTitle>{t('usage.details')}</SheetTitle>
            <SheetDescription className="mt-1 break-all">
              {selected?.model}
            </SheetDescription>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {selected && (
              <dl className="space-y-4 px-6 pb-6 text-sm">
                {tokenFields.map((field) => (
                  <div
                    key={field}
                    className="flex justify-between gap-4 border-b pb-3"
                  >
                    <dt className="text-muted-foreground">
                      {t(`usage.${field}`)}
                    </dt>
                    <dd className="tabular-nums">{value(selected[field])}</dd>
                  </div>
                ))}
                {(
                  [
                    'id',
                    'createdAt',
                    'durationMs',
                    'userId',
                    'projectId',
                    'providerId',
                    'modelReference',
                    'threadId',
                    'runId',
                    'agentId',
                    'stepNumber',
                    'finishReason',
                  ] as const
                ).map((field) => (
                  <div key={field}>
                    <dt className="text-xs text-muted-foreground">
                      {t(`usage.${field}`)}
                    </dt>
                    <dd className="mt-1 break-all">
                      {field === 'createdAt'
                        ? date.format(new Date(selected.createdAt))
                        : field === 'durationMs'
                          ? `${value(selected.durationMs)} ms`
                          : field === 'stepNumber'
                            ? selected.stepNumber + 1
                            : (selected[field] ?? '—')}
                    </dd>
                  </div>
                ))}
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('usage.tokenHint')}
                </p>
              </dl>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </section>
  );
}
