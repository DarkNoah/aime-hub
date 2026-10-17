import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import { MessageResponse } from '@/components/ai-elements/message';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { parseViewFileOutput } from './view-file-output';
import type { PreviewPart } from './selection';

export function ViewFilePreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const result = useMemo(() => parseViewFileOutput(output), [output]);
  if (!isToolUIPart(part)) return null;
  const error =
    part.errorText ||
    (result?.isError ? result.text || t('chat.viewFile.failed') : undefined);
  const loading =
    part.state === 'input-streaming' || part.state === 'input-available';
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t('tools.viewFile')}</h3>
        {getStatusBadge(error ? 'output-error' : part.state)}
        {result?.mimeType && <Badge variant="outline">{result.mimeType}</Badge>}
        {result?.truncated && (
          <Badge variant="secondary">{t('chat.viewFile.truncated')}</Badge>
        )}
      </div>
      {result ? (
        <WorkspaceFileLink path={result.file_path} />
      ) : part.input !== undefined ? (
        <ToolInput input={part.input} />
      ) : null}
      {result?.model && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t('tools.ocrModel')}: {result.model}
        </p>
      )}
      {result?.truncated && (
        <p className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
          {t('chat.viewFile.truncatedHint')}
        </p>
      )}
      {result &&
        !error &&
        (result.text.trim() ? (
          <MessageResponse
            mode="static"
            renderEnhancedLinks={false}
            className="min-w-0 text-sm leading-7 [overflow-wrap:anywhere]"
          >
            {result.text}
          </MessageResponse>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('chat.viewFile.empty')}
          </p>
        ))}
      {loading && !result && !error && (
        <div role="status" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('chat.viewFile.loading')}
          </p>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
        </div>
      )}
      <ToolOutput output={result ? undefined : part.output} errorText={error} />
    </div>
  );
}
