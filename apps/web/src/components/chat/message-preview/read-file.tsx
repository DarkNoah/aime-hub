import { useMemo } from 'react';
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
import { readFileBlocks, splitReadFileText } from './read-file-output';
import { ToolMedia } from './tool-media';
import type { PreviewPart } from './selection';

export function ReadFilePreview({ part }: { part: PreviewPart }) {
  const { t } = useTranslation();
  const input =
    isToolUIPart(part) &&
    part.input &&
    typeof part.input === 'object' &&
    !Array.isArray(part.input)
      ? (part.input as Record<string, unknown>)
      : undefined;
  const path = typeof input?.path === 'string' ? input.path : undefined;
  const output = isToolUIPart(part) ? part.output : undefined;
  const blocks = useMemo(() => readFileBlocks(output, path), [output, path]);
  if (!isToolUIPart(part)) return null;
  const hasMedia = blocks.some((block) => block.type === 'media');
  const hasOptions =
    input &&
    (typeof input.offset === 'number' ||
      typeof input.limit === 'number' ||
      typeof input.showLineNumbers === 'boolean' ||
      typeof input.encoding === 'string');
  const extra =
    input &&
    Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          !['path', 'offset', 'limit', 'showLineNumbers', 'encoding'].includes(
            key,
          ),
      ),
    );

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{getToolName(part)}</h3>
        {getStatusBadge(part.state)}
      </div>
      {path !== undefined ? (
        <WorkspaceFileLink
          path={path}
          disabled={part.state === 'input-streaming'}
        />
      ) : (
        part.input !== undefined && <ToolInput input={part.input} />
      )}
      {hasOptions && (
        <div className="flex flex-wrap gap-2">
          {typeof input.offset === 'number' && (
            <Badge variant="outline">
              {t('chat.readFile.offset', { line: input.offset })}
            </Badge>
          )}
          {typeof input.limit === 'number' && (
            <Badge variant="outline">
              {t('chat.readFile.limit', { count: input.limit })}
            </Badge>
          )}
          {typeof input.showLineNumbers === 'boolean' && (
            <Badge variant="outline">
              {t(
                input.showLineNumbers
                  ? 'chat.readFile.numbered'
                  : 'chat.readFile.unnumbered',
              )}
            </Badge>
          )}
          {typeof input.encoding === 'string' && (
            <Badge variant="outline">{input.encoding}</Badge>
          )}
        </div>
      )}
      {path !== undefined && extra && Object.keys(extra).length > 0 && (
        <ToolInput input={extra} />
      )}
      {blocks.map((block, index) => {
        if (block.type === 'media')
          return (
            <ToolMedia key={`${part.toolCallId}:${index}`} media={block} />
          );
        if (block.type === 'unknown')
          return (
            <ToolOutput
              key={index}
              output={block.value}
              errorText={undefined}
            />
          );
        if (hasMedia)
          return (
            <p
              key={index}
              className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]"
            >
              {block.text}
            </p>
          );
        const { header, content } = splitReadFileText(block.text);
        return (
          <div key={index} className="min-w-0 space-y-2">
            {header && (
              <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                {header}
              </p>
            )}
            <FileCode filename={path} code={content} showLineNumbers={false} />
          </div>
        );
      })}
      <ToolOutput output={undefined} errorText={part.errorText} />
    </div>
  );
}
