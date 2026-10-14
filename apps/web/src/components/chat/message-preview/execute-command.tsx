import { isToolUIPart } from 'ai';
import { Circle, Keyboard, RefreshCw, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getStatusBadge } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { getToolName } from '../tool-renderers/registry';
import { CommandInput } from './command-input';
import { commandRecord, parseCommandResult } from './command-data';
import { CommandTerminal } from './command-terminal';
import { StdinInput } from './stdin-input';
import type { PreviewPart } from './selection';

export function ExecuteCommandPreview({ part }: { part: PreviewPart }) {
  const { t, i18n } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const stdin = name === 'write_stdin';
  const input = commandRecord(part.input);
  const polling =
    stdin && input && (input.chars === undefined || input.chars === '');
  // Legacy execute_command returns literal stdout, including arbitrary JSON.
  const result =
    name === 'execute_command' ? null : parseCommandResult(part.output);
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available';
  const failed =
    Boolean(part.errorText) ||
    part.state === 'output-error' ||
    (result?.exitCode !== undefined && result.exitCode !== 0);
  const running =
    !failed && result?.sessionId !== undefined && result.exitCode === undefined;
  const output = [
    result?.output ??
      (part.output === undefined
        ? ''
        : typeof part.output === 'string'
          ? part.output
          : JSON.stringify(part.output, null, 2)),
    part.errorText,
  ]
    .filter(Boolean)
    .join('\n');
  const Icon = stdin ? (polling ? RefreshCw : Keyboard) : SquareTerminal;
  const sessionId =
    result?.sessionId ??
    (stdin && typeof input?.session_id === 'number'
      ? input.session_id
      : undefined);
  const empty = pending
    ? t('chat.command.waiting')
    : running
      ? t('chat.command.noNewOutput')
      : t('chat.command.noOutput');
  return (
    <div className="min-w-0 space-y-4 [&_.animate-pulse]:motion-reduce:animate-none">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="text-sm font-medium">
              {t(
                stdin
                  ? polling
                    ? 'chat.command.poll'
                    : 'chat.command.sendInput'
                  : 'chat.command.execute',
              )}
            </h3>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {name}
            </p>
          </div>
        </div>
        {running ? (
          <Badge variant="secondary" className="gap-1.5">
            <Circle className="size-3" aria-hidden="true" />
            {t('chat.command.runningAtReturn')}
          </Badge>
        ) : (
          getStatusBadge(failed ? 'output-error' : part.state)
        )}
      </div>
      {stdin ? (
        <StdinInput key={part.toolCallId} input={part.input} />
      ) : (
        <CommandInput key={part.toolCallId} input={part.input} />
      )}
      <section
        aria-label={t('chat.command.result')}
        className="min-w-0 space-y-3 border-t pt-4"
      >
        {result && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            {result.exitCode !== undefined ? (
              <Badge variant={failed ? 'destructive' : 'secondary'}>
                {t('chat.command.exitCode', { value: result.exitCode })}
              </Badge>
            ) : sessionId !== undefined && !stdin ? (
              <span>
                {t('chat.command.sessionId')}{' '}
                <span className="font-mono tabular-nums text-foreground">
                  {sessionId}
                </span>
              </span>
            ) : null}
            {result.seconds !== undefined && (
              <span>
                {t('chat.command.elapsed', {
                  value: result.seconds.toLocaleString(i18n.language, {
                    maximumFractionDigits: 2,
                  }),
                })}
              </span>
            )}
            {result.truncated && (
              <Badge variant="outline">{t('chat.command.truncated')}</Badge>
            )}
          </div>
        )}
        <CommandTerminal
          key={part.toolCallId}
          output={output}
          pending={pending}
          title={t('chat.command.result')}
          empty={empty}
        />
        {result?.truncated && (
          <p role="note" className="text-xs leading-5 text-muted-foreground">
            {result.tokens !== undefined
              ? t('chat.command.truncatedCount', {
                  value: result.tokens.toLocaleString(i18n.language),
                })
              : t('chat.command.truncatedHint')}
          </p>
        )}
      </section>
    </div>
  );
}
