import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  FileJson2,
  RefreshCw,
  Search,
} from 'lucide-react';
import type {
  RequestLogPage,
  RequestLogQuery,
} from '@aime/shared/request-logs';
import type { TranslationKey } from '@/i18n/config';
import { api } from '@/lib/rpc';
import { PageHeader } from '@/components/page-header';
import { LoadingState } from '@/components/loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Item, ItemGroup } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { RequestLogDetailSheet } from './components/detail-sheet';
import { RequestStatusBadge } from './components/status-badge';
import { formatBytes, requestLogErrorKey } from './format';

export function AdminRequestLogsPage() {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<RequestLogQuery['status']>('all');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [data, setData] = useState<RequestLogPage>();
  const [error, setError] = useState<TranslationKey>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [selected, setSelected] = useState<string>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const cursor = cursors.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.requestLogs
        .list(
          { query: { search, status, cursor, limit: 30 } },
          { signal: controller.signal },
        )
        .then(
          (result) => {
            if (!controller.signal.aborted) {
              setData(result);
              setError(undefined);
              setLoading(false);
            }
          },
          (cause) => {
            if (!controller.signal.aborted) {
              setError(requestLogErrorKey(cause));
              setLoading(false);
            }
          },
        );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search, status, cursor, revision]);

  useEffect(() => {
    if (!autoRefresh || cursor || selected || loading || error) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setLoading(true);
      setRevision((value) => value + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, cursor, selected, loading, error]);

  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title={t('nav.requestLogs')}
        description={t('admin.requestLogsDescription')}
        actions={
          <Button
            ref={refreshButton}
            variant="outline"
            disabled={loading}
            onClick={refresh}
          >
            <RefreshCw
              className={loading ? 'motion-safe:animate-spin' : undefined}
            />
            {t('requestLogs.refresh')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            maxLength={200}
            className="pl-9"
            placeholder={t('requestLogs.search')}
            aria-label={t('requestLogs.search')}
            onChange={(event) => {
              setSearch(event.target.value);
              setCursors([undefined]);
              setLoading(true);
            }}
          />
        </div>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as RequestLogQuery['status']);
            setCursors([undefined]);
            setLoading(true);
          }}
        >
          <SelectTrigger aria-label={t('requestLogs.status')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('requestLogs.all')}</SelectItem>
            <SelectItem value="complete">
              {t('requestLogs.complete')}
            </SelectItem>
            <SelectItem value="incomplete">
              {t('requestLogs.incomplete')}
            </SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Switch
            id="request-log-auto-refresh"
            checked={autoRefresh}
            onCheckedChange={setAutoRefresh}
          />
          <Label htmlFor="request-log-auto-refresh">
            {t('requestLogs.autoRefresh')}
          </Label>
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/25 p-4 text-sm text-destructive"
        >
          <span>{t(error)}</span>
          <Button variant="outline" disabled={loading} onClick={refresh}>
            {t('requestLogs.retry')}
          </Button>
        </div>
      ) : null}
      <section
        className="overflow-hidden rounded-xl border bg-card"
        aria-label={t('nav.requestLogs')}
      >
        <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-5 py-4">
          <h2 className="text-sm font-semibold">
            {t('requestLogs.listTitle')}
          </h2>
          {data ? (
            <Badge variant="secondary">
              {t('requestLogs.count', { count: data.total })}
            </Badge>
          ) : null}
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {t(
              autoRefresh && (cursor || selected)
                ? 'requestLogs.refreshPaused'
                : 'requestLogs.persisted',
            )}
          </span>
        </div>
        <ScrollArea
          className="h-[min(60dvh,42rem)]"
          viewportProps={{ className: '[&>div]:block!', 'aria-busy': loading }}
        >
          {loading && !data ? (
            <LoadingState />
          ) : data?.items.length ? (
            <ItemGroup className="divide-y">
              {data.items.map((log) => (
                <div key={log.id} role="listitem">
                  <Item
                    asChild
                    variant="ghost"
                    className="w-full flex-nowrap gap-4 rounded-none px-5 py-4 text-left"
                  >
                    <button
                      type="button"
                      aria-label={t('requestLogs.view', {
                        model: log.model ?? t('requestLogs.unknownModel'),
                        id: log.id,
                      })}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setSelected(log.id);
                      }}
                    >
                      <FileJson2
                        className="hidden size-5 shrink-0 text-muted-foreground sm:block"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 space-y-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate font-medium">
                            {log.model ?? t('requestLogs.unknownModel')}
                          </span>
                          <RequestStatusBadge status={log.status} />
                          {log.stream ? (
                            <Badge variant="outline">
                              {t('requestLogs.streaming')}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {log.method} {log.url}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {log.id}
                        </span>
                        <span className="block text-xs text-muted-foreground sm:hidden">
                          {dateFormat.format(new Date(log.createdAt))} ·{' '}
                          {formatBytes(log.bodyBytes)}
                        </span>
                      </span>
                      <span className="hidden shrink-0 space-y-2 text-right text-xs text-muted-foreground sm:block">
                        <time
                          dateTime={log.createdAt}
                          className="block tabular-nums"
                        >
                          {dateFormat.format(new Date(log.createdAt))}
                        </time>
                        <span className="block tabular-nums">
                          {formatBytes(log.bodyBytes)}
                        </span>
                      </span>
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  </Item>
                </div>
              ))}
            </ItemGroup>
          ) : !error ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <FileJson2
                className="size-8 text-muted-foreground"
                aria-hidden="true"
              />
              <h3 className="text-sm font-medium">
                {t(
                  search || status !== 'all'
                    ? 'requestLogs.noMatches'
                    : 'requestLogs.empty',
                )}
              </h3>
              <p className="max-w-md text-sm leading-6 text-muted-foreground">
                {t(
                  search || status !== 'all'
                    ? 'requestLogs.searchHint'
                    : 'requestLogs.emptyHint',
                )}
              </p>
            </div>
          ) : null}
        </ScrollArea>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
          <p className="text-xs text-muted-foreground">
            {t('requestLogs.page', { page: cursors.length })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || cursors.length === 1}
              onClick={() => {
                setLoading(true);
                setCursors((value) => value.slice(0, -1));
              }}
            >
              <ChevronLeft />
              {t('requestLogs.previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !data?.nextCursor}
              onClick={() => {
                if (data?.nextCursor) {
                  setLoading(true);
                  setCursors((value) => [...value, data.nextCursor!]);
                }
              }}
            >
              {t('requestLogs.next')}
              <ChevronRight />
            </Button>
          </div>
        </div>
      </section>
      {selected ? (
        <RequestLogDetailSheet
          key={selected}
          id={selected}
          onClose={() => setSelected(undefined)}
          restoreFocus={() =>
            (trigger.current?.isConnected
              ? trigger.current
              : refreshButton.current
            )?.focus()
          }
        />
      ) : null}
    </div>
  );
}
