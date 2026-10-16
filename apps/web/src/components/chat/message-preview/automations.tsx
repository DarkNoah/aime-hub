import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Automation } from '@aime/shared/automations';
import type { TranslationKey } from '@/i18n/config';
import { Badge } from '@/components/ui/badge';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { AutomationRunList } from '@/components/automations/run-list';
import { getToolName } from '../tool-renderers/registry';
import { parseAutomationToolResult } from './automation-data';
import type { PreviewPart } from './selection';

function AutomationCard({ task }: { task: Automation }) {
  const { t, i18n } = useTranslation();
  const time = (value: string) =>
    new Date(value).toLocaleString(i18n.language, { timeZone: task.timezone });
  return (
    <article className="min-w-0 space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="break-words text-sm font-medium">{task.name}</h4>
        <Badge variant={task.enabled ? 'secondary' : 'outline'}>
          {t(task.enabled ? 'automations.enabled' : 'automations.paused')}
        </Badge>
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">
        {task.id}
      </p>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          {t(`automations.title.${task.scope.scope}`)}
        </Badge>
        <Badge variant="outline" className="font-mono">
          {task.cron}
        </Badge>
        <Badge variant="outline">{task.timezone}</Badge>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
        {task.prompt}
      </p>
      <p className="text-xs text-muted-foreground">
        {task.nextFireAt
          ? t('automations.nextRun', { time: time(task.nextFireAt) })
          : t('automations.noNextRun')}
      </p>
      {task.lastFireAt && (
        <p className="text-xs text-muted-foreground">
          {t('automations.lastRun', { time: time(task.lastFireAt) })}
        </p>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs [&_dt]:text-muted-foreground [&_dd]:break-all">
        <dt>{t('automations.agent')}</dt>
        <dd>{task.settings.agentId ?? '—'}</dd>
        <dt>{t('automations.model')}</dt>
        <dd>{task.settings.model ?? t('automations.defaultModel')}</dd>
        <dt>{t('automations.maxSteps')}</dt>
        <dd>{task.maxSteps ?? t('automations.unlimitedSteps')}</dd>
      </dl>
    </article>
  );
}

export function AutomationsPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseAutomationToolResult(output), [output]);
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part) ?? '';
  const failed = part.state === 'output-error' || !!part.errorText;
  const tasks =
    result && 'items' in result
      ? result.items
      : result && 'automation' in result
        ? [result.automation]
        : [];
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <CalendarClock
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t(`agents.tool.${name}` as TranslationKey)}
        </h3>
        {getStatusBadge(failed ? 'output-error' : part.state)}
      </div>
      {part.input !== undefined && <ToolInput input={part.input} />}
      {!result || failed ? (
        <ToolOutput output={part.output} errorText={part.errorText} />
      ) : (
        <>
          {'items' in result && (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {t('automations.count', { count: result.items.length })}
                </Badge>
                <Badge variant="outline">{result.timezone}</Badge>
              </div>
              {!result.canManage && (
                <p className="text-sm text-muted-foreground">
                  {t('automations.readOnly')}
                </p>
              )}
              {result.items.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('automations.empty')}
                </p>
              )}
            </>
          )}
          {'requested' in result && result.requested && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('automations.queued')}
            </p>
          )}
          {tasks.map((task) => (
            <AutomationCard key={task.id} task={task} />
          ))}
          {'deleted' in result && (
            <div className="space-y-2">
              <Badge variant="outline">{t('automations.deleted')}</Badge>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {result.id}
              </p>
            </div>
          )}
          {'runs' in result && result.runs && (
            <section className="space-y-3">
              <h4 className="text-sm font-medium">
                {t('automations.history')}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t('automations.historyHint')} · {result.automation.timezone}
              </p>
              <AutomationRunList
                runs={result.runs}
                timezone={result.automation.timezone}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
