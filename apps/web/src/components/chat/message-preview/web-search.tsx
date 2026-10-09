import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { ExternalLink, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@/components/ui/item';
import { getToolName } from '../tool-renderers/registry';
import {
  parseWebSearchOutput,
  webSearchLink,
  type WebSearchResult,
} from './web-search-output';
import type { PreviewPart } from './selection';

function SearchResult({ result }: { result: WebSearchResult }) {
  const { t } = useTranslation();
  const link = webSearchLink(result.href);
  const title =
    result.title.trim() || result.href || t('chat.webSearch.untitled');
  const content = (
    <ItemContent className="min-w-0 gap-2">
      <ItemTitle className="w-full items-start justify-between leading-6">
        <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        {link ? (
          <ExternalLink
            className="mt-1 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : null}
      </ItemTitle>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {link?.hostname || result.href}
      </p>
      {result.snippet ? (
        <ItemDescription className="line-clamp-none whitespace-pre-wrap text-pretty leading-6 [overflow-wrap:anywhere]">
          {result.snippet}
        </ItemDescription>
      ) : null}
      {!link && (
        <Badge variant="outline">{t('chat.webSearch.linkUnavailable')}</Badge>
      )}
    </ItemContent>
  );

  return (
    <li className="min-w-0">
      {link ? (
        <Item asChild variant="ghost" size="sm" className="min-w-0 px-3">
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            title={t('chat.webSearch.openLink', { title })}
          >
            {content}
          </a>
        </Item>
      ) : (
        <Item size="sm" className="min-w-0 px-3">
          {content}
        </Item>
      )}
    </li>
  );
}

export function WebSearchPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseWebSearchOutput(output), [output]);
  if (!isToolUIPart(part)) return null;
  const input =
    part.input && typeof part.input === 'object' && !Array.isArray(part.input)
      ? (part.input as Record<string, unknown>)
      : undefined;
  const query = typeof input?.query === 'string' ? input.query : undefined;
  const extra =
    input &&
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== 'query'),
    );
  const error =
    part.errorText ||
    (result?.isError
      ? result.message || t('chat.webSearch.failed')
      : undefined);
  const loading =
    part.state === 'input-streaming' || part.state === 'input-available';

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{getToolName(part)}</h3>
        {getStatusBadge(error ? 'output-error' : part.state)}
      </div>
      {query !== undefined ? (
        <section
          aria-label={t('chat.webSearch.query')}
          className="min-w-0 space-y-2 rounded-lg bg-muted/50 p-3"
        >
          <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            {t('chat.webSearch.query')}
          </h4>
          <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
            {query}
          </p>
        </section>
      ) : part.input !== undefined ? (
        <ToolInput input={part.input} />
      ) : null}
      {query !== undefined && extra && Object.keys(extra).length > 0 && (
        <ToolInput input={extra} />
      )}
      {result && (
        <section
          aria-label={t('chat.webSearch.results')}
          className="min-w-0 space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              {t('chat.webSearch.results')}
            </h4>
            <Badge variant="secondary">
              {t('chat.webSearch.count', { count: result.results.length })}
            </Badge>
            {result.provider && (
              <Badge
                variant="outline"
                className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
              >
                {t('chat.webSearch.provider', { provider: result.provider })}
              </Badge>
            )}
            {result.fallback && (
              <Badge variant="outline">{t('chat.webSearch.fallback')}</Badge>
            )}
          </div>
          {result.message && !error && (
            <p
              role="note"
              className="text-sm leading-6 [overflow-wrap:anywhere]"
            >
              {result.message}
            </p>
          )}
          {result.results.length > 0 ? (
            <ol className="min-w-0 space-y-1">
              {result.results.map((entry, index) => (
                <SearchResult key={`${index}:${entry.href}`} result={entry} />
              ))}
            </ol>
          ) : !error && part.state === 'output-available' ? (
            <p
              role="status"
              className="py-6 text-center text-sm leading-6 text-muted-foreground"
            >
              {t('chat.webSearch.empty')}
            </p>
          ) : null}
        </section>
      )}
      {loading && !result && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('chat.webSearch.searching')}
        </p>
      )}
      <ToolOutput
        output={result ? undefined : part.output}
        errorText={error}
        className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
      />
    </div>
  );
}
