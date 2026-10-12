import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { ExternalLink, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MessageResponse } from '@/components/ai-elements/message';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Item, ItemContent, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { getToolName } from '../tool-renderers/registry';
import { parseWebFetchOutput } from './web-fetch-output';
import { webPreviewLink } from './web-link';
import type { PreviewPart } from './selection';

export function WebFetchPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseWebFetchOutput(output), [output]);
  if (!isToolUIPart(part)) return null;
  const input =
    part.input && typeof part.input === 'object' && !Array.isArray(part.input)
      ? (part.input as Record<string, unknown>)
      : undefined;
  const requestedUrl = typeof input?.url === 'string' ? input.url : undefined;
  const source = result?.url ?? requestedUrl;
  const link = source ? webPreviewLink(source) : null;
  const title =
    result?.title?.trim() || link?.hostname || t('chat.webFetch.source');
  const extra =
    input &&
    Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'url'));
  const error =
    part.errorText ||
    (result?.isError
      ? result.content.trim() || t('chat.webFetch.failed')
      : undefined);
  const loading =
    part.state === 'input-streaming' || part.state === 'input-available';
  const contentType = result?.contentType?.split(';')[0].trim().toLowerCase();
  const markdown = !contentType || contentType === 'text/markdown';
  const sourceContent = (
    <ItemContent className="min-w-0 gap-2">
      <ItemTitle className="w-full items-start gap-2 leading-6">
        <Globe
          className="mt-1 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{title}</span>
        {link ? (
          <ExternalLink
            className="mt-1 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
      </ItemTitle>
      <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        {source}
      </p>
      {!link && (
        <Badge variant="outline">{t('chat.webFetch.linkUnavailable')}</Badge>
      )}
    </ItemContent>
  );

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{getToolName(part)}</h3>
        {getStatusBadge(error ? 'output-error' : part.state)}
      </div>
      {source !== undefined && (
        <section
          aria-label={t('chat.webFetch.source')}
          className="min-w-0 space-y-2"
        >
          {link ? (
            <Item asChild variant="muted" size="sm" className="min-w-0 px-3">
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                title={t('chat.webFetch.openLink')}
              >
                {sourceContent}
              </a>
            </Item>
          ) : (
            <Item variant="muted" size="sm" className="min-w-0 px-3">
              {sourceContent}
            </Item>
          )}
          {requestedUrl && result?.url && requestedUrl !== result.url && (
            <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {t('chat.webFetch.requestedUrl', { url: requestedUrl })}
            </p>
          )}
        </section>
      )}
      {requestedUrl === undefined && part.input !== undefined ? (
        <ToolInput input={part.input} />
      ) : extra && Object.keys(extra).length > 0 ? (
        <ToolInput input={extra} />
      ) : null}
      {result && !error && (
        <section
          aria-label={t('chat.webFetch.content')}
          className="min-w-0 space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {t('chat.webFetch.content')}
            </h4>
            {result.provider && (
              <Badge
                variant="outline"
                className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
              >
                {t('chat.webFetch.provider', {
                  provider:
                    result.provider === 'jina-ai'
                      ? 'Jina AI'
                      : result.provider === 'local'
                        ? t('chat.webFetch.localReader')
                        : result.provider,
                })}
              </Badge>
            )}
            {result.fallback && (
              <Badge variant="outline">{t('chat.webFetch.fallback')}</Badge>
            )}
            {result.truncated && (
              <Badge variant="secondary">{t('chat.webFetch.truncated')}</Badge>
            )}
          </div>
          {result.truncated && (
            <p
              role="note"
              className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground"
            >
              {t('chat.webFetch.truncatedHint')}
            </p>
          )}
          {result.content.trim() ? (
            markdown ? (
              <MessageResponse
                mode="static"
                renderEnhancedLinks={false}
                className="min-w-0 max-w-prose text-sm leading-7 [overflow-wrap:anywhere] [&_img]:max-w-full"
              >
                {result.content}
              </MessageResponse>
            ) : (
              <pre className="whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-mono text-xs leading-6 [overflow-wrap:anywhere]">
                {result.content}
              </pre>
            )
          ) : (
            <p
              role="status"
              className="py-6 text-center text-sm text-muted-foreground"
            >
              {t('chat.webFetch.empty')}
            </p>
          )}
        </section>
      )}
      {loading && !result && !error && (
        <div role="status" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('chat.webFetch.loading')}
          </p>
          <div aria-hidden="true" className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        </div>
      )}
      <ToolOutput
        output={result ? undefined : part.output}
        errorText={error}
        className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
      />
    </div>
  );
}
