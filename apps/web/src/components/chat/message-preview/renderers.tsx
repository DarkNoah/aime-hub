import { KnowledgePreview, KnowledgeManagementPreview } from './knowledge';
import { automationToolNames } from '@aime/shared/automations';
import { AutomationsPreview } from './automations';
import type { ComponentType, ReactNode } from 'react';
import { isToolUIPart } from 'ai';
import { useTranslation } from 'react-i18next';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { MessageResponse } from '@/components/ai-elements/message';
import {
  getStatusBadge,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { ChatMessageCompression } from '../chat-message-compression';
import { getMessageCompression } from '../message-compression';
import { ExecuteCommandPreview } from './execute-command';
import { ExecPreview } from './exec';
import { TaskPreview } from './task';
import { EditFilePreview } from './edit-file';
import { WriteFilePreview } from './write-file';
import { GrepPreview } from './grep';
import { ReadFilePreview } from './read-file';
import { WebSearchPreview } from './web-search';
import { WebFetchPreview } from './web-fetch';
import { ImageGenPreview } from './generated-media';
import { SpeechPreview } from './speech';
import { LspPreview } from './lsp';
import { BrowserPreview } from './browser';
import type { PreviewPart } from './selection';
import { getToolName } from '../tool-renderers/registry';

type PreviewProps = { part: PreviewPart };

function RawPreview({ part }: PreviewProps) {
  return (
    <CodeBlock
      code={JSON.stringify(part, null, 2)}
      language="json"
      className="[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
    />
  );
}

function ToolPreview({ part }: PreviewProps) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-all text-sm font-medium">{name}</h3>
        {getStatusBadge(part.state)}
      </div>
      {part.input !== undefined && <ToolInput input={part.input} />}
      <ToolOutput output={part.output} errorText={part.errorText} />
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="text-sm leading-6 [overflow-wrap:anywhere]">
        {children}
      </div>
    </section>
  );
}

function ObservationPreview({ part }: PreviewProps) {
  const { t } = useTranslation();
  const compression = getMessageCompression(part);
  if (
    !compression ||
    !('data' in part) ||
    !part.data ||
    typeof part.data !== 'object'
  )
    return <RawPreview part={part} />;
  const data = part.data;
  return (
    <div className="space-y-5">
      <ChatMessageCompression compression={compression} />
      {'observations' in data && typeof data.observations === 'string' && (
        <DetailSection title={t('chat.preview.observations')}>
          <MessageResponse>{data.observations}</MessageResponse>
        </DetailSection>
      )}
      {'currentTask' in data && typeof data.currentTask === 'string' && (
        <DetailSection title={t('chat.preview.currentTask')}>
          <MessageResponse>{data.currentTask}</MessageResponse>
        </DetailSection>
      )}
      {'suggestedResponse' in data &&
        typeof data.suggestedResponse === 'string' && (
          <DetailSection title={t('chat.preview.suggestedResponse')}>
            <MessageResponse>{data.suggestedResponse}</MessageResponse>
          </DetailSection>
        )}
    </div>
  );
}

// Add a data part type or `tool:<toolName>` here to give it a dedicated preview.
const previewRenderers: Partial<Record<string, ComponentType<PreviewProps>>> = {
  ...Object.fromEntries(
    automationToolNames.map((name) => [`tool:${name}`, AutomationsPreview]),
  ),
  'tool:execute_command': ExecuteCommandPreview,
  'tool:exec_command': ExecuteCommandPreview,
  'tool:write_stdin': ExecuteCommandPreview,
  'tool:edit_file': EditFilePreview,
  'tool:write_file': WriteFilePreview,
  'tool:grep': GrepPreview,
  'tool:read_file': ReadFilePreview,
  'tool:exec': ExecPreview,
  'tool:task_write': TaskPreview,
  'tool:task_update': TaskPreview,
  'tool:task_complete': TaskPreview,
  'tool:task_check': TaskPreview,
  'tool:knowledge_search': KnowledgePreview,
  'tool:knowledge_list': KnowledgeManagementPreview,
  'tool:knowledge_create': KnowledgeManagementPreview,
  'tool:knowledge_get_document': KnowledgeManagementPreview,
  'tool:knowledge_save_document': KnowledgeManagementPreview,
  'tool:knowledge_archive_document': KnowledgeManagementPreview,
  'tool:web_search': WebSearchPreview,
  'tool:web_fetch': WebFetchPreview,
  'tool:image_gen': ImageGenPreview,
  'tool:speech': SpeechPreview,
  'tool:lsp_inspect': LspPreview,
  'tool:mastra_workspace_lsp_inspect': LspPreview,
  'data-om-observation-end': ObservationPreview,
  'data-om-buffering-end': ObservationPreview,
  'data-om-activation': ObservationPreview,
};

export function MessagePartPreview({ part }: PreviewProps) {
  const toolName = isToolUIPart(part) ? getToolName(part) : undefined;
  const Renderer =
    (toolName ? previewRenderers[`tool:${toolName}`] : undefined) ??
    (toolName?.startsWith('browser_') ? BrowserPreview : undefined) ??
    previewRenderers[part.type] ??
    (isToolUIPart(part) ? ToolPreview : RawPreview);
  return <Renderer part={part} />;
}
