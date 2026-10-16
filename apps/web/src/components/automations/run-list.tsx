import { useTranslation } from 'react-i18next';
import type { AutomationRun } from '@aime/shared/automations';
import { Badge } from '@/components/ui/badge';
import { automationErrorKey } from './errors';

export function AutomationRunList({
  runs,
  timezone,
}: {
  runs: AutomationRun[];
  timezone: string;
}) {
  const { t, i18n } = useTranslation();
  if (runs.length === 0)
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t('automations.noRuns')}
      </p>
    );
  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <article key={run.id} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <time className="text-sm" dateTime={run.firedAt}>
              {new Date(run.firedAt).toLocaleString(i18n.language, {
                timeZone: timezone,
              })}
            </time>
            <Badge
              variant={run.status === 'failed' ? 'destructive' : 'secondary'}
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
  );
}
