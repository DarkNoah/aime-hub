import { useTranslation } from 'react-i18next';
import type { UsageSummary, UsageQuery, UsageGroup } from '@aime/shared/usage';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

export function UsageBreakdown({
  data,
  onFilter,
}: {
  data: UsageSummary;
  onFilter: (patch: Partial<UsageQuery>) => void;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  function filter(kind: 'users' | 'projects' | 'models', row: UsageGroup) {
    onFilter(
      kind === 'models'
        ? { model: row.id ?? '', providerId: row.providerId ?? '__none__' }
        : { [kind === 'users' ? 'userId' : 'projectId']: row.id ?? '__none__' },
    );
  }
  return (
    <section className="min-w-0 rounded-xl border bg-card p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t('usage.breakdown')}</h2>
        <p className="text-xs text-muted-foreground">{t('usage.topHint')}</p>
      </div>
      <Tabs defaultValue="users">
        <TabsList aria-label={t('usage.breakdown')}>
          {(['users', 'projects', 'models'] as const).map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {t(`usage.${kind}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {(['users', 'projects', 'models'] as const).map((kind) => (
          <TabsContent value={kind} key={kind}>
            <ScrollArea
              className="max-h-[420px] w-full overflow-hidden"
              viewportProps={{ className: 'max-h-[420px]' }}
            >
              <table className="w-full min-w-[700px] text-sm">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr>
                    <th className="py-3 pr-4 text-left font-medium">
                      {t(`usage.${kind}`)}
                    </th>
                    {(
                      [
                        'requests',
                        'inputTokens',
                        'outputTokens',
                        'totalTokens',
                      ] as const
                    ).map((key) => (
                      <th
                        key={key}
                        className="px-3 py-3 text-right font-medium"
                      >
                        {t(`usage.${key}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data[kind].map((row) => (
                    <tr key={`${row.providerId ?? ''}:${row.id ?? '__none__'}`}>
                      <td className="max-w-80 py-3 pr-4">
                        <Button
                          variant="link"
                          className="h-auto max-w-full justify-start p-0 text-left text-foreground"
                          onClick={() => filter(kind, row)}
                        >
                          <span className="truncate">
                            {row.name ??
                              row.id ??
                              t(
                                kind === 'projects'
                                  ? 'usage.personal'
                                  : 'usage.unknown',
                              )}
                          </span>
                        </Button>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {kind === 'models'
                            ? (row.providerName ??
                              row.providerId ??
                              t('usage.unknownProvider'))
                            : row.id}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {number.format(row.requests)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {number.format(row.inputTokens)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {number.format(row.outputTokens)}
                      </td>
                      <td className="px-3 py-3 text-right font-medium tabular-nums">
                        {number.format(row.totalTokens)}
                        <div className="mt-1 ml-auto h-1 w-20 rounded bg-muted">
                          <div
                            className="h-full rounded bg-primary"
                            style={{
                              width: `${data.totals.totalTokens ? (row.totalTokens / data.totals.totalTokens) * 100 : 0}%`,
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
