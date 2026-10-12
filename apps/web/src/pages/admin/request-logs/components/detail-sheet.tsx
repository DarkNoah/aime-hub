import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import {
  requestLogContextFields,
  type RequestLogDetail,
  type RequestLogSummary,
} from '@aime/shared/request-logs';
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
import { RequestStatusBadge, ResponseStatusBadge } from './status-badge';
import { RequestLogBodyView } from './body-view';
import { formatBytes, formatDuration, requestLogErrorKey } from '../format';

export function RequestLogDetailSheet({
  id,
  onClose,
  restoreFocus,
  onUpdate,
}: {
  id: string;
  onClose: () => void;
  restoreFocus: () => void;
  onUpdate: (summary: RequestLogSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<RequestLogDetail>();
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const [bodyTab, setBodyTab] = useState('request');
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = () => {
      void api.requestLogs
        .get({ params: { id } }, { signal: controller.signal })
        .then(
          (data) => {
            if (!controller.signal.aborted) {
              setDetail(data);
              setError(undefined);
              const {
                body: _body,
                responseBody: _responseBody,
                ...summary
              } = data;
              void _body;
              void _responseBody;
              onUpdate(summary);
              if (data.responseStatus === 'pending')
                timer = window.setTimeout(load, 1500);
            }
          },
          (cause) => {
            if (!controller.signal.aborted) setError(requestLogErrorKey(cause));
          },
        );
    };
    load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, revision, onUpdate]);

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
                  {t('requestLogs.duration')}
                </dt>
                <dd title={t('requestLogs.durationHint')}>
                  {formatDuration(detail.durationMs)}
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.responseStatus')}
                </dt>
                <dd>
                  {detail.responseStatus === null ? (
                    '—'
                  ) : (
                    <ResponseStatusBadge
                      responseStatus={detail.responseStatus}
                      httpStatus={detail.httpStatus}
                    />
                  )}
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.responseSize')}
                </dt>
                <dd>
                  {detail.responseBytes === null
                    ? '—'
                    : formatBytes(detail.responseBytes)}
                </dd>
                <dt className="text-muted-foreground">
                  {t('requestLogs.responseContentType')}
                </dt>
                <dd className="break-all font-mono text-xs leading-5">
                  {detail.responseContentType ?? '—'}
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
                {requestLogContextFields.map((field) => (
                  <Fragment key={field}>
                    <dt className="text-muted-foreground">
                      {t(`requestLogs.${field}`)}
                    </dt>
                    <dd className="break-all font-mono text-xs leading-5">
                      {detail[field] ?? '—'}
                    </dd>
                  </Fragment>
                ))}
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
            {detail.responseStatus === 'incomplete' ? (
              <p className="px-5 pb-4 text-sm text-destructive sm:px-6">
                {t('requestLogs.responseIncompleteHint')}
              </p>
            ) : null}
            <Tabs
              value={bodyTab}
              onValueChange={setBodyTab}
              className="min-h-0 flex-1 gap-0"
            >
              <div className="border-y px-5 py-3 sm:px-6">
                <TabsList aria-label={t('requestLogs.contentView')}>
                  <TabsTrigger value="request">
                    {t('requestLogs.body')}
                  </TabsTrigger>
                  <TabsTrigger value="response">
                    {t('requestLogs.responseBody')}
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent
                value={bodyTab}
                className="flex min-h-0 flex-1 flex-col"
              >
                <RequestLogBodyView
                  key={bodyTab}
                  body={
                    bodyTab === 'request' ? detail.body : detail.responseBody
                  }
                  base64={
                    bodyTab === 'response' &&
                    detail.responseBodyEncoding === 'base64'
                  }
                  emptyHint={
                    detail.responseStatus === 'pending'
                      ? 'requestLogs.responsePendingHint'
                      : detail.responseStatus === null
                        ? 'requestLogs.responseUnavailable'
                        : 'requestLogs.noResponse'
                  }
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
