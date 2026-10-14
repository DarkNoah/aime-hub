import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { ToolInput } from '@/components/ai-elements/tool';
import { commandRecord, stdinSegments } from './command-data';
import { CommandOptions } from './command-options';
import { CommandTerminal } from './command-terminal';

export function StdinInput({ input }: { input: unknown }) {
  const { t } = useTranslation();
  const data = commandRecord(input);
  if (
    !data ||
    typeof data.session_id !== 'number' ||
    (data.chars !== undefined && typeof data.chars !== 'string')
  )
    return input === undefined ? null : <ToolInput input={input} />;
  const {
    session_id,
    chars = '',
    yield_time_ms,
    max_output_tokens,
    ...extra
  } = data;
  const text = chars as string;
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          {t('chat.command.sessionId')}
        </span>
        <span className="font-mono tabular-nums">{session_id}</span>
      </div>
      {text ? (
        <CommandTerminal
          output={text}
          title={t('chat.command.inputText')}
          copyLabel={t('chat.command.copyInput')}
          copiedLabel={t('chat.command.inputCopied')}
        >
          <pre className="whitespace-pre-wrap leading-7 [overflow-wrap:anywhere]">
            {stdinSegments(text).map((segment, index) => (
              <Fragment key={index}>
                {segment.key ? (
                  <kbd className="mx-0.5 inline rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 font-mono text-[11px] text-zinc-200">
                    {segment.key}
                  </kbd>
                ) : (
                  segment.text
                )}
                {segment.newline ? '\n' : null}
              </Fragment>
            ))}
          </pre>
        </CommandTerminal>
      ) : (
        <p className="rounded-md bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          {t('chat.command.pollHint')}
        </p>
      )}
      <CommandOptions input={{ yield_time_ms, max_output_tokens }} />
      {Object.keys(extra).length > 0 && <ToolInput input={extra} />}
    </div>
  );
}
