import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { FileCode } from '@/components/file-code';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { PreviewPart } from './selection';

export function ExtractPreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const input =
    part.input && typeof part.input === 'object'
      ? (part.input as Record<string, unknown>)
      : undefined;
  const source = typeof input?.source === 'string' ? input.source : undefined;
  const output = typeof part.output === 'string' ? part.output : undefined;
  const cancelled = output === '用户中止了操作';
  const loading =
    part.state === 'input-streaming' || part.state === 'input-available';
  const error = part.errorText || (cancelled ? output : undefined);
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t('tools.extract')}</h3>
        {getStatusBadge(error ? 'output-error' : part.state)}
        <Badge variant="outline">JSON</Badge>
      </div>
      {source &&
        (/^https?:\/\//i.test(source) ? (
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-sm text-primary underline"
          >
            {source}
          </a>
        ) : (
          <WorkspaceFileLink
            path={source}
            disabled={part.state === 'input-streaming'}
          />
        ))}
      {input && (
        <ToolInput
          input={Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== 'source'),
          )}
        />
      )}
      {output !== undefined && !error && (
        <FileCode
          filename="extracted.json"
          code={output}
          showLineNumbers={false}
        />
      )}
      {loading && !error && (
        <div role="status" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('chat.extract.loading')}
          </p>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
        </div>
      )}
      <ToolOutput
        output={output === undefined ? part.output : undefined}
        errorText={error}
      />
    </div>
  );
}
