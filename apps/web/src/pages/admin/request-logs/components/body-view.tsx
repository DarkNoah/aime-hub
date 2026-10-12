import { useMemo, useState } from 'react';
import { truncateBase64, truncateJsonBody } from '@aime/shared/log-json';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TranslationKey } from '@/i18n/config';
import { formatBody } from '../format';

export function RequestLogBodyView({
  body,
  emptyHint,
  base64 = false,
}: {
  body: string | null;
  emptyHint: TranslationKey;
  base64?: boolean;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState('formatted');
  const preview = useMemo(
    () =>
      body === null
        ? ''
        : base64
          ? truncateBase64(body)
          : truncateJsonBody(body),
    [body, base64],
  );
  const displayed = useMemo(
    () => (mode === 'raw' || base64 ? preview : formatBody(preview)),
    [preview, mode, base64],
  );
  async function copy() {
    if (body === null) return;
    try {
      await navigator.clipboard.writeText(preview);
      toast.success(t('requestLogs.copied'));
    } catch {
      toast.error(t('requestLogs.copyFailed'));
    }
  }
  return (
    <Tabs value={mode} onValueChange={setMode} className="min-h-0 flex-1 gap-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-5 py-3 sm:px-6">
        <TabsList aria-label={t('requestLogs.bodyView')}>
          <TabsTrigger value="formatted">
            {t('requestLogs.formatted')}
          </TabsTrigger>
          <TabsTrigger value="raw">{t('requestLogs.raw')}</TabsTrigger>
        </TabsList>
        <Button
          size="sm"
          variant="outline"
          disabled={body === null}
          onClick={() => void copy()}
        >
          <Copy />
          {t('requestLogs.copy')}
        </Button>
      </div>
      {base64 ? (
        <p className="px-5 pt-3 text-xs text-muted-foreground sm:px-6">
          {t('requestLogs.base64Hint')}
        </p>
      ) : null}
      <TabsContent value={mode} className="min-h-0 flex-1">
        <ScrollArea
          className="h-full"
          viewportProps={{
            className: '[&>div]:block!',
            tabIndex: 0,
            'aria-label': t('requestLogs.bodyView'),
          }}
        >
          {body === null ? (
            <p className="p-5 text-sm text-muted-foreground sm:p-6">
              {t(emptyHint)}
            </p>
          ) : body === '' ? (
            <p className="p-5 text-sm text-muted-foreground sm:p-6">
              {t('requestLogs.emptyBody')}
            </p>
          ) : (
            <pre className="m-0 p-5 font-mono text-xs leading-6 break-all whitespace-pre-wrap sm:p-6">
              <code>{displayed}</code>
            </pre>
          )}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}
