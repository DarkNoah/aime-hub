import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { RequestLogDetail } from '@aime/shared/request-logs';
import { api } from '@/lib/rpc';
import type { TranslationKey } from '@/i18n/config';
import { LoadingState } from '@/components/loading-state';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RequestStatusBadge } from './status-badge';
import { formatBody, formatBytes, requestLogErrorKey } from '../format';

export function RequestLogDetailSheet({
  id,
  onClose,
  restoreFocus,
}: {
  id: string;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<RequestLogDetail>();
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState('formatted');
  useEffect(() => {
    const controller = new AbortController();
    void api.requestLogs
      .get({ params: { id } }, { signal: controller.signal })
      .then(
        (data) => {
          if (!controller.signal.aborted) {
            setDetail(data);
            setError(undefined);
          }
        },
        (cause) => {
          if (!controller.signal.aborted) setError(requestLogErrorKey(cause));
        },
      );
    return () => controller.abort();
  }, [id, revision]);
  const body = useMemo(
    () =>
      detail ? (mode === 'raw' ? detail.body : formatBody(detail.body)) : '',
    [detail, mode],
  );

  async function copy() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.body);
      toast.success(t('requestLogs.copied'));
    } catch {
      toast.error(t('requestLogs.copyFailed'));
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <div className="space-y-2 border-b px-5 py-5 pr-14 sm:px-6">
          <SheetTitle>{t('requestLogs.detail')}</SheetTitle>
          <SheetDescription>{t('requestLogs.detailHint')}</SheetDescription>
        </div>
        {error ? (
          <div
            role="alert"
            className="m-5 flex items-center justify-between gap-3 rounded-lg border border-destructive/25 p-4 text-sm text-destructive"
          >
            {t(error)}
            <Button
              variant="outline"
              onClick={() => {
                setError(undefined);
                setRevision((value) => value + 1);
              }}
            >
              <RefreshCw />
              {t('requestLogs.retry')}
            </Button>
          </div>
        ) : !detail ? (
          <LoadingState />
        ) : (
          <>
            <ScrollArea
              className="max-h-[32dvh] shrink-0"
              viewportProps={{ className: '[&>div]:block!' }}
            >
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 px-5 py-5 text-sm sm:px-6">
                <dt className="text-muted-foreground">
                  {t('requestLogs.model')}
                </dt>
                <dd className="break-all font-medium">
                  {detail.model ?? t('requestLogs.unknownModel')}
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.time')}
                </dt>
                <dd>
                  {new Date(detail.createdAt).toLocaleString(i18n.language)}
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.status')}
                </dt>
                <dd>
                  <RequestStatusBadge status={detail.status} />
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.endpoint')}
                </dt>
                <dd className="break-all font-mono text-xs leading-5">
                  {detail.method} {detail.url}
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.requestId')}
                </dt>
                <dd className="break-all font-mono text-xs leading-5">
                  {detail.id}
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.size')}
                </dt>
                <dd>{formatBytes(detail.bodyBytes)}</dd>
              </dl>
            </ScrollArea>
            {detail.status === 'incomplete' ? (
              <p className="px-5 pb-4 text-sm text-destructive sm:px-6">
                {t('requestLogs.incompleteHint')}
              </p>
            ) : null}
            <Tabs
              value={mode}
              onValueChange={setMode}
              className="min-h-0 flex-1 gap-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-y bg-muted/30 px-5 py-3 sm:px-6">
                <TabsList aria-label={t('requestLogs.bodyView')}>
                  <TabsTrigger value="formatted">
                    {t('requestLogs.formatted')}
                  </TabsTrigger>
                  <TabsTrigger value="raw">{t('requestLogs.raw')}</TabsTrigger>
                </TabsList>
                <Button size="sm" variant="outline" onClick={() => void copy()}>
                  <Copy />
                  {t('requestLogs.copy')}
                </Button>
              </div>
              <TabsContent value={mode} className="min-h-0 flex-1">
                <ScrollArea
                  className="h-full"
                  viewportProps={{
                    className: '[&>div]:block!',
                    tabIndex: 0,
                    'aria-label': t('requestLogs.body'),
                  }}
                >
                  <pre className="m-0 p-5 font-mono text-xs leading-6 break-all whitespace-pre-wrap sm:p-6">
                    <code>{body}</code>
                  </pre>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
