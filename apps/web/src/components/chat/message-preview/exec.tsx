import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { Code2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements/code-block';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { commandRecord } from './command-data';
import { CommandTerminal } from './command-terminal';
import { readFileBlocks } from './read-file-output';
import type { PreviewPart } from './selection';
import { ToolMedia } from './tool-media';

export function ExecPreview({ part }: { part: PreviewPart }) {
  const { t, i18n } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const blocks = useMemo(() => readFileBlocks(output), [output]);
  if (!isToolUIPart(part)) return null;

  const input = commandRecord(part.input);
  const code = typeof input?.code === 'string' ? input.code : undefined;
  const result = commandRecord(output);
  const failed =
    part.state === 'output-error' ||
    Boolean(part.errorText) ||
    result?.isError === true;
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available';
  const extra = input
    ? Object.fromEntries(
        Object.entries(input).filter(
          ([key]) =>
            !['code', 'yield_time_ms', 'max_output_tokens'].includes(key),
        ),
      )
    : {};
  const number = (value: unknown, fallback: number) =>
    (typeof value === 'number' && Number.isFinite(value)
      ? value
      : fallback
    ).toLocaleString(i18n.language);

  return (
    <div className="min-w-0 space-y-4 [&_.animate-pulse]:motion-reduce:animate-none">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <Code2
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-medium">{t('chat.exec.title')}</h3>
            <p className="mt-1 font-mono text-xs text-muted-foreground">exec</p>
          </div>
        </div>
        {getStatusBadge(failed ? 'output-error' : part.state)}
      </div>
      {code !== undefined ? (
        <>
          <CodeBlock
            code={code}
            language="javascript"
            className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
          >
            <CodeBlockHeader>
              <CodeBlockTitle>JavaScript</CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton
                  key={part.toolCallId}
                  className="size-7"
                  aria-label={t('chat.exec.copyCode')}
                  title={t('chat.exec.copyCode')}
                  disabled={!code}
                  onCopy={() => toast.success(t('chat.exec.codeCopied'))}
                  onError={() => toast.error(t('chat.preview.copyFailed'))}
                />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs leading-5 [&_dt]:text-muted-foreground [&_dd]:[overflow-wrap:anywhere]">
            <dt>{t('chat.command.timeout')}</dt>
            <dd>
              {t('chat.command.milliseconds', {
                value: number(input?.yield_time_ms, 30000),
              })}
            </dd>
            <dt>{t('chat.command.outputBudget')}</dt>
            <dd>
              {t('chat.command.tokenCount', {
                value: number(input?.max_output_tokens, 10000),
              })}
            </dd>
          </dl>
          {Object.keys(extra).length > 0 && <ToolInput input={extra} />}
        </>
      ) : (
        part.input !== undefined && <ToolInput input={part.input} />
      )}
      <section
        aria-label={t('chat.toolResult')}
        className="min-w-0 space-y-3 border-t pt-4"
      >
        {result?.truncated === true && (
          <div className="space-y-2">
            <Badge variant="outline">{t('chat.command.truncated')}</Badge>
            <p role="note" className="text-xs leading-5 text-muted-foreground">
              {t('chat.command.truncatedHint')}
            </p>
          </div>
        )}
        {blocks.map((block, index) => {
          const key = `${part.toolCallId}:${index}`;
          if (block.type === 'media')
            return <ToolMedia key={key} media={block} />;
          if (block.type === 'text')
            return (
              <CommandTerminal
                key={key}
                output={block.text}
                title={t('chat.toolResult')}
                copyLabel={t('chat.exec.copyOutput')}
              />
            );
          return (
            <ToolOutput key={key} output={block.value} errorText={undefined} />
          );
        })}
        {blocks.length === 0 &&
          !failed &&
          (pending || part.state === 'output-available') && (
            <p
              role="status"
              className="text-sm leading-6 text-muted-foreground"
            >
              {t(pending ? 'chat.exec.waiting' : 'chat.exec.noOutput')}
            </p>
          )}
        <ToolOutput output={undefined} errorText={part.errorText} />
      </section>
    </div>
  );
}
