import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { FileDiff } from '@/components/file-diff';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { getToolName } from '../tool-renderers/registry';
import type { PreviewPart } from './selection';

export function EditFilePreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const input =
    part.input && typeof part.input === 'object' && !Array.isArray(part.input)
      ? (part.input as Record<string, unknown>)
      : undefined;
  const hasDiff =
    typeof input?.old_string === 'string' &&
    typeof input?.new_string === 'string';

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{getToolName(part)}</h3>
        {getStatusBadge(part.state)}
      </div>
      {typeof input?.path === 'string' && (
        <WorkspaceFileLink
          path={input.path}
          disabled={part.state === 'input-streaming'}
        />
      )}
      {typeof input?.replace_all === 'boolean' && (
        <Badge variant="outline">
          {t(
            input.replace_all
              ? 'chat.editFile.replaceAll'
              : 'chat.editFile.uniqueMatch',
          )}
        </Badge>
      )}
      {hasDiff ? (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            {t('chat.editFile.fragmentHint')}
          </p>
          <FileDiff
            key={part.toolCallId}
            filename={typeof input.path === 'string' ? input.path : undefined}
            oldValue={input.old_string as string}
            newValue={input.new_string as string}
          />
        </>
      ) : part.input !== undefined ? (
        <ToolInput input={part.input} />
      ) : null}
      <ToolOutput output={part.output} errorText={part.errorText} />
    </div>
  );
}
