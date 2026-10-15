import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { ChevronDown, ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { getToolName } from '../tool-renderers/registry';
import { commandRecord } from './command-data';
import { parseTaskList, parseTaskOutput, taskStatusSchema } from './task-data';
import { TaskList, TaskStatusBadge } from './task-list';
import type { PreviewPart } from './selection';

const titles = {
  task_write: 'chat.tasks.write',
  task_update: 'agents.tool.task_update',
  task_complete: 'agents.tool.task_complete',
  task_check: 'agents.tool.task_check',
} as const;

function TaskRequest({ name, input }: { name: string; input: unknown }) {
  const { t } = useTranslation();
  const data = commandRecord(input);
  if (name === 'task_write') {
    const tasks = parseTaskList(data?.tasks);
    if (tasks)
      return (
        <TaskList
          tasks={tasks}
          title={t('chat.tasks.requestList')}
          showProgress={false}
        />
      );
  }
  if (name === 'task_check' && data && Object.keys(data).length === 0)
    return null;
  if (
    (name === 'task_update' || name === 'task_complete') &&
    typeof data?.id === 'string'
  ) {
    const status = taskStatusSchema.safeParse(data.status);
    const extra = Object.fromEntries(
      Object.entries(data).filter(([key, value]) => {
        if (key === 'id') return false;
        if (key === 'status') return !status.success;
        if (key === 'content' || key === 'activeForm')
          return typeof value !== 'string';
        return true;
      }),
    );
    return (
      <section
        aria-label={t('chat.tasks.request')}
        className="min-w-0 space-y-3 rounded-lg bg-muted/40 p-3"
      >
        <h4 className="text-xs font-medium text-muted-foreground">
          {t('chat.tasks.request')}
        </h4>
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs leading-5 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:whitespace-pre-wrap [&_dd]:[overflow-wrap:anywhere]">
          <dt>{t('chat.tasks.id')}</dt>
          <dd className="font-mono">{data.id}</dd>
          {typeof data.content === 'string' && (
            <>
              <dt>{t('chat.tasks.content')}</dt>
              <dd>{data.content}</dd>
            </>
          )}
          {typeof data.activeForm === 'string' && (
            <>
              <dt>{t('chat.tasks.activeForm')}</dt>
              <dd>{data.activeForm}</dd>
            </>
          )}
          {status.success && (
            <>
              <dt>{t('chat.tasks.status')}</dt>
              <dd>
                <TaskStatusBadge status={status.data} />
              </dd>
            </>
          )}
        </dl>
        {Object.keys(extra).length > 0 && <ToolInput input={extra} />}
      </section>
    );
  }
  return input === undefined ? null : <ToolInput input={input} />;
}

export function TaskPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseTaskOutput(output), [output]);
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part) ?? '';
  const title = titles[name as keyof typeof titles];
  const input = commandRecord(part.input);
  const failed =
    part.state === 'output-error' ||
    !!part.errorText ||
    result?.isError === true;
  const error =
    part.errorText ||
    (result?.isError ? result.content || t('chat.tasks.failed') : undefined);
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available';

  return (
    <div className="min-w-0 space-y-4 [&_.animate-pulse]:motion-reduce:animate-none">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <ClipboardList
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{title ? t(title) : name}</h3>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {name}
            </p>
          </div>
        </div>
        {getStatusBadge(failed ? 'output-error' : part.state)}
      </div>
      {(!result || failed || name !== 'task_write') && (
        <TaskRequest name={name} input={part.input} />
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t('chat.toolError')}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {error}
          </AlertDescription>
        </Alert>
      )}
      {result && (
        <TaskList
          tasks={result.tasks}
          title={t('chat.tasks.snapshot')}
          highlightId={
            !failed && typeof input?.id === 'string' ? input.id : undefined
          }
        />
      )}
      {pending && !result && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('chat.tasks.waiting')}
        </p>
      )}
      {result?.content && !result.isError && (
        <Collapsible key={part.toolCallId} className="group border-t pt-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between text-muted-foreground"
            >
              {t('chat.tasks.details')}
              <ChevronDown
                className="size-3.5 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <p className="whitespace-pre-wrap text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
              {result.content}
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
      {!result && <ToolOutput output={part.output} errorText={undefined} />}
    </div>
  );
}
