import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { cn } from '@/lib/utils';
import { getToolName } from '../tool-renderers/registry';
import { parseGrepOutput } from './grep-output';
import type { PreviewPart } from './selection';

function GrepInput({ input }: { input: unknown }) {
  const { t } = useTranslation();
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !('pattern' in input) ||
    typeof input.pattern !== 'string'
  )
    return input === undefined ? null : <ToolInput input={input} />;

  const {
    pattern,
    path,
    contextLines,
    maxCount,
    caseSensitive,
    includeHidden,
    ...extra
  } = input as Record<string, unknown> & { pattern: string };
  return (
    <div className="min-w-0 space-y-3">
      <section
        aria-label={t('chat.grep.pattern')}
        className="rounded-lg border bg-card p-3"
      >
        <h4 className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Search className="size-3.5" aria-hidden="true" />
          {t('chat.grep.pattern')}
        </h4>
        <pre className="whitespace-pre-wrap font-mono text-sm [overflow-wrap:anywhere]">
          {pattern || t('chat.grep.emptyPattern')}
        </pre>
      </section>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs leading-5">
        <dt className="text-muted-foreground">{t('chat.grep.path')}</dt>
        <dd className="font-mono [overflow-wrap:anywhere]">
          {typeof path === 'string' ? path : '.'}
        </dd>
        {typeof contextLines === 'number' && (
          <>
            <dt className="text-muted-foreground">{t('chat.grep.context')}</dt>
            <dd>{t('chat.grep.contextLines', { count: contextLines })}</dd>
          </>
        )}
        {typeof maxCount === 'number' && (
          <>
            <dt className="text-muted-foreground">{t('chat.grep.limit')}</dt>
            <dd>{maxCount}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          {t(
            caseSensitive === false
              ? 'chat.grep.ignoreCase'
              : 'chat.grep.caseSensitive',
          )}
        </Badge>
        {includeHidden === true && (
          <Badge variant="outline">{t('chat.grep.includeHidden')}</Badge>
        )}
      </div>
      {Object.keys(extra).length > 0 && <ToolInput input={extra} />}
    </div>
  );
}

export function GrepPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseGrepOutput(output), [output]);
  if (!isToolUIPart(part)) return null;
  const outputError =
    typeof part.output === 'string' && part.output.startsWith('Error: ')
      ? part.output
      : undefined;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{getToolName(part)}</h3>
        {getStatusBadge(part.state)}
      </div>
      <GrepInput input={part.input} />
      {result ? (
        <section
          aria-label={t('chat.grep.results')}
          className="min-w-0 space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {t('chat.grep.results')}
            </h4>
            <Badge variant="secondary">
              {t('chat.grep.summary', {
                matches: result.matchCount,
                files: result.fileCount,
              })}
            </Badge>
          </div>
          {result.note && (
            <p
              role="note"
              className="whitespace-pre-wrap rounded-md border p-3 text-xs leading-5 [overflow-wrap:anywhere]"
            >
              {result.note}
            </p>
          )}
          {result.matchCount === 0 && !result.note && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('chat.grep.empty')}
            </p>
          )}
          {result.files.map((file) => (
            <section
              key={file.path}
              aria-label={file.path}
              className="min-w-0 overflow-hidden rounded-lg border bg-card"
            >
              <div className="border-b p-1">
                <WorkspaceFileLink path={file.path} />
              </div>
              <div className="py-1 font-mono text-xs leading-5">
                {file.lines.map((line, index) => (
                  <div key={index}>
                    {line.gapBefore && (
                      <div
                        aria-hidden="true"
                        className="border-y border-dashed px-3 text-muted-foreground"
                      >
                        ···
                      </div>
                    )}
                    <div
                      className={cn(
                        'flex gap-3 px-3 py-0.5',
                        line.column !== undefined &&
                          'bg-accent text-accent-foreground',
                      )}
                    >
                      <span
                        className="w-14 shrink-0 select-none text-right tabular-nums text-muted-foreground"
                        title={
                          line.column === undefined
                            ? t('chat.grep.contextLine', { line: line.line })
                            : t('chat.grep.matchLine', {
                                line: line.line,
                                column: line.column,
                              })
                        }
                      >
                        {line.line}
                        {line.column !== undefined && `:${line.column}`}
                      </span>
                      <code className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {line.content || '\u00a0'}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {result.unparsed && (
            <pre className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
              {result.unparsed}
            </pre>
          )}
        </section>
      ) : null}
      <ToolOutput
        output={result || outputError ? undefined : part.output}
        errorText={part.errorText || outputError}
        className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
      />
    </div>
  );
}
