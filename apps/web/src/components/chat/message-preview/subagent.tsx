import { useMemo, type ReactNode } from 'react';
import { isToolUIPart } from 'ai';
import { Bot, ChevronDown, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MessageResponse } from '@/components/ai-elements/message';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { getToolName } from '../tool-renderers/registry';
import { commandRecord } from './command-data';
import { parseSubagentOutput, subagentToolPart } from './subagent-data';
import type { PreviewPart } from './selection';

export function SubagentPreview({
  part,
  renderTool,
}: {
  part: PreviewPart;
  renderTool: (part: PreviewPart) => ReactNode;
}) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseSubagentOutput(output), [output]);
  const tools = useMemo(
    () =>
      result?.tools?.map((value) => ({ value, part: subagentToolPart(value) })),
    [result],
  );
  if (!isToolUIPart(part)) return null;
  const input = commandRecord(part.input);
  const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined;
  const extra =
    input &&
    Object.fromEntries(
      Object.entries(input).filter(
        ([key]) => key !== 'prompt' || prompt === undefined,
      ),
    );
  const failed =
    part.state === 'output-error' ||
    !!part.errorText ||
    result?.data?.isError === true ||
    result?.data?.finishReason === 'error';
  const pending =
    !failed &&
    (part.state === 'input-streaming' || part.state === 'input-available');
  const metadata = [
    ['subAgentThreadId', 'chat.subagent.thread'],
    ['subAgentResourceId', 'chat.subagent.resource'],
    ['ref', 'chat.subagent.reference'],
    ['finishReason', 'chat.subagent.finishReason'],
  ] as const;
  const details = metadata.filter(
    ([key]) => typeof result?.data?.[key] === 'string',
  );
  const errors =
    tools?.filter((tool) => tool.part?.state === 'output-error').length ?? 0;

  return (
    <div className="min-w-0 space-y-5 [&_.animate-pulse]:motion-reduce:animate-none">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Bot
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{t('chat.subagent.title')}</h3>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {getToolName(part)?.slice('agent-'.length)}
            </p>
          </div>
        </div>
        {getStatusBadge(failed ? 'output-error' : part.state)}
      </div>
      {prompt !== undefined ? (
        <section
          aria-label={t('chat.subagent.prompt')}
          className="min-w-0 space-y-2"
        >
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chat.subagent.prompt')}
          </h4>
          <p className="rounded-lg bg-muted/40 p-3 text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {prompt}
          </p>
        </section>
      ) : (
        part.input !== undefined && <ToolInput input={part.input} />
      )}
      {(details.length > 0 || (extra && Object.keys(extra).length > 0)) && (
        <Collapsible
          key={`${part.toolCallId}:details`}
          className="group/details min-w-0"
        >
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between text-muted-foreground"
            >
              {t('chat.subagent.details')}
              <ChevronDown
                className="size-3.5 transition-transform group-data-[state=open]/details:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            {extra && Object.keys(extra).length > 0 && (
              <ToolInput input={extra} />
            )}
            {details.length > 0 && (
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs leading-5 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-all [&_dd]:font-mono">
                {details.map(([key, label]) => (
                  <div key={key} className="contents">
                    <dt>{t(label)}</dt>
                    <dd>{result?.data?.[key] as string}</dd>
                  </div>
                ))}
              </dl>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
      {failed && (
        <Alert variant="destructive">
          <AlertTitle>{t('chat.toolError')}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {part.errorText || t('chat.subagent.failed')}
          </AlertDescription>
        </Alert>
      )}
      {result && (
        <section
          aria-label={t('chat.subagent.response')}
          className="min-w-0 space-y-2 border-t pt-4"
        >
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chat.subagent.response')}
          </h4>
          {result.text ? (
            <MessageResponse
              className="text-sm leading-6 [overflow-wrap:anywhere]"
              isAnimating={pending}
            >
              {result.text}
            </MessageResponse>
          ) : (
            !pending && (
              <p className="text-sm text-muted-foreground">
                {t('chat.subagent.empty')}
              </p>
            )
          )}
        </section>
      )}
      {!result && <ToolOutput output={part.output} errorText={undefined} />}
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('chat.subagent.waiting')}
        </p>
      )}
      {tools !== undefined && (
        <section
          aria-label={t('chat.subagent.tools')}
          className="min-w-0 space-y-3 border-t pt-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {t('chat.subagent.tools')}
            </h4>
            <Badge variant="secondary">{tools.length}</Badge>
            {errors > 0 && (
              <Badge variant="destructive">
                {t('chat.subagent.toolErrors', { count: errors })}
              </Badge>
            )}
          </div>
          {tools.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('chat.subagent.noTools')}
            </p>
          )}
          <div className="divide-y">
            {tools.map((tool, index) => (
              <Collapsible
                key={`${part.toolCallId}:${index}:${tool.part?.toolCallId ?? ''}`}
                className="group/child min-w-0 py-1"
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start gap-2 px-2 py-2.5 text-left"
                  >
                    <Wrench
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {tool.part?.toolName ??
                        t('chat.subagent.unknownTool', { index: index + 1 })}
                    </span>
                    {tool.part && getStatusBadge(tool.part.state)}
                    <ChevronDown
                      className="size-3.5 shrink-0 transition-transform group-data-[state=open]/child:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="min-w-0 px-2 pt-3 pb-4">
                  {tool.part ? (
                    renderTool(tool.part)
                  ) : (
                    <ToolOutput output={tool.value} errorText={undefined} />
                  )}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
