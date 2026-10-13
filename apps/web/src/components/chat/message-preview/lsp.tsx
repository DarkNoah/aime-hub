import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import { MessageResponse } from '@/components/ai-elements/message';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { getToolName } from '../tool-renderers/registry';
import { parseLspOutput } from './lsp-output';
import type { PreviewPart } from './selection';

export function LspPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const result = parseLspOutput(part.output);
  const empty =
    result &&
    !result.error &&
    !result.hover?.value &&
    !result.diagnostics?.length &&
    !result.definition?.length &&
    !result.implementation?.length;
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{getToolName(part)}</h3>
        {getStatusBadge(result?.error ? 'output-error' : part.state)}
      </div>
      {part.input !== undefined && <ToolInput input={part.input} />}
      {result?.hover?.value && (
        <section className="min-w-0 space-y-2" aria-label={t('chat.lsp.hover')}>
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chat.lsp.hover')}
          </h4>
          {result.hover.kind === 'markdown' ? (
            <MessageResponse>{result.hover.value}</MessageResponse>
          ) : (
            <pre className="whitespace-pre-wrap rounded-lg border bg-card p-3 text-xs [overflow-wrap:anywhere]">
              {result.hover.value}
            </pre>
          )}
        </section>
      )}
      {!!result?.diagnostics?.length && (
        <section className="space-y-2" aria-label={t('chat.lsp.diagnostics')}>
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chat.lsp.diagnostics')}
          </h4>
          {result.diagnostics.map((diagnostic, index) => (
            <div
              key={index}
              className="space-y-2 rounded-lg border bg-card p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    diagnostic.severity === 'error'
                      ? 'destructive'
                      : 'secondary'
                  }
                >
                  {diagnostic.severity === 'error'
                    ? t('chat.lsp.error')
                    : diagnostic.severity === 'warning'
                      ? t('chat.lsp.warning')
                      : diagnostic.severity === 'info'
                        ? t('chat.lsp.info')
                        : diagnostic.severity === 'hint'
                          ? t('chat.lsp.hint')
                          : diagnostic.severity}
                </Badge>
                {diagnostic.source && (
                  <span className="text-xs text-muted-foreground">
                    {diagnostic.source}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                {diagnostic.message}
              </p>
            </div>
          ))}
        </section>
      )}
      {!!result?.definition?.length && (
        <section className="space-y-2" aria-label={t('chat.lsp.definition')}>
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chat.lsp.definition')}
          </h4>
          {result.definition.map((definition, index) => (
            <div
              key={index}
              className="overflow-hidden rounded-lg border bg-card"
            >
              <p className="p-3 font-mono text-xs [overflow-wrap:anywhere]">
                {definition.location}
              </p>
              {definition.preview !== null && (
                <pre className="whitespace-pre-wrap border-t bg-muted/50 p-3 text-xs [overflow-wrap:anywhere]">
                  {definition.preview}
                </pre>
              )}
            </div>
          ))}
        </section>
      )}
      {!!result?.implementation?.length && (
        <section
          className="space-y-2"
          aria-label={t('chat.lsp.implementation')}
        >
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('chat.lsp.implementation')}
          </h4>
          {result.implementation.map((location, index) => (
            <p
              key={index}
              className="rounded-lg border p-3 font-mono text-xs [overflow-wrap:anywhere]"
            >
              {location}
            </p>
          ))}
        </section>
      )}
      {empty && (
        <p className="text-sm text-muted-foreground">{t('chat.lsp.empty')}</p>
      )}
      <ToolOutput
        output={result ? undefined : part.output}
        errorText={part.errorText || result?.error}
      />
    </div>
  );
}
