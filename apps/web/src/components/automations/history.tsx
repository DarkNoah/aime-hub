import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Automation, AutomationRun } from '@aime/shared/automations';
import { api } from '@/lib/rpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { LoadingState } from '@/components/loading-state';
import { automationErrorKey } from './errors';

export function AutomationHistory({
  task,
  onClose,
  restoreFocus,
}: {
  task: Automation;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [runs, setRuns] = useState<AutomationRun[]>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.automations.history(
          { id: task.id },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setRuns(result);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(t(automationErrorKey(cause)));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 4000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [task.id, revision, t]);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <div className="space-y-2 border-b px-6 py-5 pr-14">
          <SheetTitle>{t('automations.history')}</SheetTitle>
          <SheetDescription>
            {task.name} · {t('automations.historyHint')}
          </SheetDescription>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-6">
            {error && (
              <div role="alert" className="space-y-3 text-sm text-destructive">
                <p>{error}</p>
                <Button
                  variant="outline"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {t('providers.retry')}
                </Button>
              </div>
            )}
            {!runs && !error && <LoadingState />}
            {runs?.length === 0 && (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {t('automations.noRuns')}
              </p>
            )}
            {runs?.map((run) => (
              <article key={run.id} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <time className="text-sm" dateTime={run.firedAt}>
                    {new Date(run.firedAt).toLocaleString(i18n.language, {
                      timeZone: task.timezone,
                    })}
                  </time>
                  <Badge
                    variant={
                      run.status === 'failed' ? 'destructive' : 'secondary'
                    }
                  >
                    {t(`automations.status.${run.status}`)}
                  </Badge>
                </div>
                {run.error && (
                  <p className="text-sm text-muted-foreground">
                    {t(automationErrorKey(run.error))}
                  </p>
                )}
                {run.text && (
                  <div className="whitespace-pre-wrap break-words text-sm leading-7">
                    {run.text}
                  </div>
                )}
              </article>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
