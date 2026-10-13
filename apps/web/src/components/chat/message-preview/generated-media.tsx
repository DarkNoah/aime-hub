import { useMemo } from 'react';
import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { WorkspaceFileLink } from '@/components/file-manager/workspace-file-link';
import { readFileBlocks } from './read-file-output';
import { ToolMedia } from './tool-media';
import type { TranslationKey } from '@/i18n/config';
import type { PreviewPart } from './selection';

export function GeneratedMediaPreview({
  part,
  title,
}: {
  part: PreviewPart;
  title: TranslationKey;
}) {
  const { t } = useTranslation();
  const output = isToolUIPart(part) ? part.output : undefined;
  const parsed = useMemo(() => {
    if (typeof output !== 'string') return output;
    try {
      return JSON.parse(output) as unknown;
    } catch {
      return output;
    }
  }, [output]);
  const record =
    parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  const path =
    typeof record?.file_path === 'string' ? record.file_path : undefined;
  const blocks = useMemo(() => readFileBlocks(parsed, path), [parsed, path]);
  if (!isToolUIPart(part)) return null;
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t(title)}</h3>
        {getStatusBadge(record?.isError ? 'output-error' : part.state)}
      </div>
      {part.input !== undefined && <ToolInput input={part.input} />}
      {path && <WorkspaceFileLink path={path} />}
      {blocks.map((block, index) =>
        block.type === 'media' ? (
          <ToolMedia key={index} media={block} />
        ) : block.type === 'text' ? (
          <p
            key={index}
            role={record?.isError ? 'alert' : undefined}
            className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]"
          >
            {block.text}
          </p>
        ) : (
          <ToolOutput key={index} output={block.value} errorText={undefined} />
        ),
      )}
      <ToolOutput output={undefined} errorText={part.errorText} />
    </div>
  );
}

export function ImageGenPreview({ part }: { part: PreviewPart }) {
  return <GeneratedMediaPreview part={part} title="tools.imageGen" />;
}
