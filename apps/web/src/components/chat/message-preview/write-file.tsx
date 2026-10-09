import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { FileCode } from '@/components/file-code';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { getToolName } from '../tool-renderers/registry';
import type { PreviewPart } from './selection';

export function WriteFilePreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  if (!isToolUIPart(part)) return null;
  const input =
    part.input && typeof part.input === 'object' && !Array.isArray(part.input)
      ? (part.input as Record<string, unknown>)
      : undefined;

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
      {typeof input?.overwrite === 'boolean' && (
        <Badge variant="outline">
          {t(
            input.overwrite
              ? 'chat.writeFile.overwrite'
              : 'chat.writeFile.createOnly',
          )}
        </Badge>
      )}
      {typeof input?.content === 'string' ? (
        <FileCode
          filename={typeof input.path === 'string' ? input.path : undefined}
          code={input.content}
        />
      ) : part.input !== undefined ? (
        <ToolInput input={part.input} />
      ) : null}
      <ToolOutput output={part.output} errorText={part.errorText} />
    </div>
  );
}
