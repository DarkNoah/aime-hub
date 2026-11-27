import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, ScanText } from 'lucide-react';
import {
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';
import type {
  AskUserAnswer,
  ToolInteraction,
  ToolResponse,
} from '@aime/shared/threads';
import {
  isSubagentTool,
  isChatToolGroupPart,
  type ChatToolGroup,
} from '@aime/shared/chat-turns';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PreviewImage } from '@/components/image-viewer/preview-image';
import { ChatBackgroundTask } from './chat-background-task';
import { ChatMessageActions } from './chat-message-actions';
import { UserMessageText } from './user-message-text';
import { ChatMessageAttachments } from './chat-message-attachments';
import { splitMessageAttachments } from './message-attachments';
import { ChatMessageCompression } from './chat-message-compression';
import { ChatToolAttachments } from './chat-tool-attachments';
import { getToolAttachments } from './tool-attachments';
import { ChatToolRenderer } from './tool-renderers';
import { ChatQuestionGroup } from './chat-question-group';
import { getToolName, isSpecialTool } from './tool-renderers/registry';
import { SubagentBadge } from './subagent-badge';
import { useMessagePreview } from './message-preview/context';
import {
  groupChatMessages,
  groupMessageParts,
  type ChatMessagePart,
} from './messages';

export function ChatMessages({
  messages,
  threadId,
  running,
  activeMessageId,
  toolInteractions = [],
  onToolResponse,
  disabled,
  hideUserMessages = false,
  toolGroupsExpanded = false,
}: {
  messages: UIMessage[];
  threadId?: string;
  running: boolean;
  activeMessageId: string | null;
  toolInteractions?: ToolInteraction[];
  onToolResponse?: (
    interactionId: string,
    response: ToolResponse,
  ) => Promise<void>;
  disabled?: boolean;
  hideUserMessages?: boolean;
  toolGroupsExpanded?: boolean;
}) {
  const rows = groupChatMessages(
    messages,
    new Set(toolInteractions.map((item) => item.toolCallId)),
  );
  const lastMessageId = messages.at(-1)?.id;
  const visibleToolIds = new Set(
    messages.flatMap((message) =>
      message.parts.filter(isToolUIPart).map((part) => part.toolCallId),
    ),
  );
  return (
    <>
      {rows
        .filter((row) => !hideUserMessages || row.message.role !== 'user')
        .map(({ message, sourceIds, parts, elapsedMs }) => (
          <ChatMessage
            key={message.id}
            message={message}
            threadId={threadId}
            parts={parts}
            elapsedMs={elapsedMs}
            streaming={
              running &&
              !!activeMessageId &&
              sourceIds.includes(activeMessageId)
            }
            isLastMessage={sourceIds.includes(lastMessageId ?? '')}
            toolInteractions={toolInteractions}
            onToolResponse={onToolResponse}
            disabled={disabled}
            toolGroupsExpanded={toolGroupsExpanded}
          />
        ))}
      {toolInteractions
        .filter(
          (item) => !item.response && !visibleToolIds.has(item.toolCallId),
        )
        .map((interaction) => (
          <ChatToolRenderer
            key={interaction.id}
            interaction={interaction}
            onRespond={onToolResponse}
            disabled={disabled}
          />
        ))}
    </>
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  threadId,
  parts,
  elapsedMs,
  streaming,
  thinking = false,
  isLastMessage = false,
  toolInteractions = [],
  onToolResponse,
  questionsByCall,
  questionInteractions = [],
  onQuestionResponses,
  questionsDisabled,
  disabled,
  hideToolDetails = false,
  toolGroupsExpanded = false,
  renderToolGroup,
}: {
  message: UIMessage;
  threadId?: string;
  parts?: ChatMessagePart[];
  elapsedMs?: number;
  streaming: boolean;
  thinking?: boolean;
  isLastMessage?: boolean;
  toolInteractions?: ToolInteraction[];
  onToolResponse?: (
    interactionId: string,
    response: ToolResponse,
  ) => Promise<void>;
  questionsByCall?: ReadonlyMap<string, (ToolUIPart | DynamicToolUIPart)[]>;
  questionInteractions?: readonly ToolInteraction[];
  onQuestionResponses?: (
    interactionId: string,
    answers: AskUserAnswer[],
  ) => Promise<void>;
  questionsDisabled?: boolean;
  disabled?: boolean;
  hideToolDetails?: boolean;
  toolGroupsExpanded?: boolean;
  renderToolGroup?: (group: ChatToolGroup) => ReactNode;
}) {
  const { t } = useTranslation();
  const openPreview = useMessagePreview();
  const display = useMemo(() => splitMessageAttachments(message), [message]);
  const displayMessage = { ...message, parts: display.parts };
  const groupedParts =
    (message.role === 'user' ? undefined : parts) ??
    groupMessageParts(
      displayMessage,
      new Set(toolInteractions.map((item) => item.toolCallId)),
    );
  if (
    message.parts.length > 0 &&
    !thinking &&
    groupedParts.length === 0 &&
    !display.attachments.length
  )
    return null;
  return (
    <Message from={message.role} className="w-full min-w-0 max-w-full">
      {(groupedParts.length > 0 || thinking) && (
        <MessageContent
          data-chat-message-content
          className="min-w-0 max-w-full overflow-hidden text-sm leading-7 [overflow-wrap:anywhere] group-[.is-assistant]:w-full"
        >
          {groupedParts.map((item) => {
            if (item.type === 'compression') {
              return (
                <ChatMessageCompression
                  key={`compression-${item.compression.cycleId}`}
                  compression={item.compression}
                  onPreview={
                    openPreview &&
                    (item.compression.status === 'completed' ||
                      item.compression.status === 'buffered')
                      ? () => openPreview(item.part)
                      : undefined
                  }
                />
              );
            }
            if (item.type === 'tools') {
              if (hideToolDetails)
                return (
                  <Fragment key={item.id}>
                    {item.tools
                      .filter(
                        (tool) =>
                          ['image_gen', 'speech'].includes(
                            getToolName(tool) ?? '',
                          ) &&
                          getToolAttachments([tool], threadId).length === 0,
                      )
                      .map((tool) => (
                        <Tool
                          key={`${tool.toolCallId}:${tool.state.startsWith('output-') ? 'result' : 'pending'}`}
                          defaultOpen={tool.state.startsWith('output-')}
                          className="my-3"
                        >
                          <ToolHeader
                            {...(tool.type === 'dynamic-tool'
                              ? { type: tool.type, toolName: tool.toolName }
                              : { type: tool.type })}
                            state={tool.state}
                            output={tool.output}
                          />
                          <ToolContent>
                            <ToolOutput
                              output={tool.output}
                              errorText={tool.errorText}
                            />
                          </ToolContent>
                        </Tool>
                      ))}
                    <ChatToolAttachments
                      tools={item.tools}
                      threadId={threadId}
                    />
                  </Fragment>
                );
              const tools = item.tools.map((tool) => {
                const content = (
                  <Tool
                    key={tool.toolCallId}
                    defaultOpen={false}
                    className={
                      toolGroupsExpanded ? 'mb-0 rounded-none border-0' : 'mb-0'
                    }
                  >
                    <ToolHeader
                      {...(tool.type === 'dynamic-tool'
                        ? { type: tool.type, toolName: tool.toolName }
                        : { type: tool.type })}
                      state={tool.state}
                      output={tool.output}
                      compact={toolGroupsExpanded}
                      onPreview={
                        openPreview ? () => openPreview(tool) : undefined
                      }
                    />
                    <ToolContent
                      className={
                        toolGroupsExpanded
                          ? 'border-t border-border/60 px-2 py-3 motion-reduce:animate-none'
                          : undefined
                      }
                    >
                      {tool.input !== undefined && (
                        <ToolInput input={tool.input} />
                      )}
                      <ToolOutput
                        output={tool.output}
                        errorText={tool.errorText}
                      />
                    </ToolContent>
                  </Tool>
                );
                return toolGroupsExpanded ? (
                  content
                ) : (
                  <ChainOfThoughtStep
                    key={tool.toolCallId}
                    status={
                      tool.state.startsWith('output-')
                        ? 'complete'
                        : tool.state === 'input-streaming'
                          ? 'pending'
                          : 'active'
                    }
                    label={content}
                  />
                );
              });
              return (
                <Fragment key={item.id}>
                  {toolGroupsExpanded ? (
                    <div className="min-w-0 divide-y divide-border/60">
                      {tools}
                    </div>
                  ) : (
                    <ChainOfThought
                      // Reset the default only when the message becomes history.
                      key={`${item.id}:${isLastMessage ? 'last-message' : 'history'}`}
                      defaultOpen={false}
                      className="min-w-0"
                    >
                      <ChainOfThoughtHeader>
                        {t('chat.toolGroup', { count: item.tools.length })}
                      </ChainOfThoughtHeader>
                      <ChainOfThoughtContent>{tools}</ChainOfThoughtContent>
                    </ChainOfThought>
                  )}
                  <ChatToolAttachments tools={item.tools} threadId={threadId} />
                </Fragment>
              );
            }
            const { part, index } = item;
            if (isChatToolGroupPart(part))
              return (
                <Fragment key={`tool-group:${part.data.id}`}>
                  {renderToolGroup?.(part.data)}
                </Fragment>
              );
            if (isToolUIPart(part)) {
              const questions = questionsByCall?.get(part.toolCallId);
              if (questions) {
                if (questions[0].toolCallId !== part.toolCallId) return null;
                return (
                  <ChatQuestionGroup
                    key={`questions:${part.toolCallId}`}
                    tools={questions}
                    interactions={questionInteractions.filter(
                      (item) =>
                        questionsByCall?.get(item.toolCallId) === questions,
                    )}
                    onSubmit={onQuestionResponses}
                    disabled={questionsDisabled}
                    onPreview={openPreview ?? undefined}
                  />
                );
              }
              const interaction = toolInteractions.find(
                (item) => item.toolCallId === part.toolCallId,
              );
              const name = getToolName(part);
              if (isSubagentTool(name) && !interaction)
                return (
                  <SubagentBadge
                    key={part.toolCallId}
                    agent={{
                      toolCallId: part.toolCallId,
                      toolName: name,
                      state: part.state,
                    }}
                    onPreview={
                      openPreview ? () => openPreview(part) : undefined
                    }
                  />
                );
              if (!interaction && !isSpecialTool(name))
                return (
                  <Tool key={part.toolCallId} defaultOpen className="my-3">
                    <ToolHeader
                      {...(part.type === 'dynamic-tool'
                        ? { type: part.type, toolName: part.toolName }
                        : { type: part.type })}
                      state={part.state}
                      output={part.output}
                      onPreview={
                        openPreview ? () => openPreview(part) : undefined
                      }
                    />
                    <ToolContent>
                      {part.input !== undefined && (
                        <ToolInput input={part.input} />
                      )}
                      <ToolOutput
                        output={part.output}
                        errorText={part.errorText}
                      />
                    </ToolContent>
                    <ChatToolAttachments tools={[part]} threadId={threadId} />
                  </Tool>
                );
              return (
                <div
                  key={interaction?.id ?? part.toolCallId}
                  className="min-w-0 space-y-1"
                >
                  {openPreview && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto flex h-7 gap-1.5 text-xs text-muted-foreground"
                      onClick={() => openPreview(part)}
                    >
                      <ScanText className="size-3.5" aria-hidden="true" />
                      {t('chat.preview.open')}
                    </Button>
                  )}
                  <ChatToolRenderer
                    interaction={interaction}
                    tool={part}
                    onRespond={onToolResponse}
                    disabled={disabled}
                  />
                </div>
              );
            }
            if (part.type === 'data-background-task-completed') {
              const data = part.data;
              if (
                !data ||
                typeof data !== 'object' ||
                !('toolName' in data) ||
                typeof data.toolName !== 'string' ||
                !data.toolName.trim()
              )
                return null;
              return (
                <ChatBackgroundTask
                  key={index}
                  toolName={data.toolName}
                  result={'result' in data ? data.result : undefined}
                />
              );
            }
            // Aborted streams may never send text-end. Their partial text still
            // belongs in the stopped conversation instead of remaining hidden.
            if (part.type === 'text')
              return message.role === 'user' ? (
                <p key={index} className="whitespace-pre-wrap">
                  <UserMessageText text={part.text} threadId={threadId} />
                </p>
              ) : (
                <MessageResponse
                  key={index}
                  isAnimating={streaming}
                  workspaceThreadId={threadId}
                >
                  {part.text}
                </MessageResponse>
              );
            if (part.type === 'file' && part.mediaType.startsWith('image/'))
              return (
                <PreviewImage
                  key={index}
                  src={part.url}
                  alt={part.filename ?? t('chat.image')}
                  loading="lazy"
                  className="max-h-72 max-w-full rounded-lg object-contain"
                />
              );
            return null;
          })}
          {thinking && (
            <Badge
              role="status"
              variant="ghost"
              className="gap-1.5 overflow-visible px-0 text-sm font-normal text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="inline-grid size-6 shrink-0 origin-bottom place-items-center text-lg leading-none select-none motion-safe:animate-thinking-tilt"
              >
                🤔
              </span>
              <span>{t('chat.thinking')}</span>
            </Badge>
          )}
        </MessageContent>
      )}
      <ChatMessageAttachments
        attachments={display.attachments}
        threadId={threadId}
      />
      <ChatMessageActions
        message={displayMessage}
        streaming={streaming}
        elapsedMs={elapsedMs}
      />
      {streaming && !thinking && (
        <LoaderCircle
          className="mb-2 size-3 animate-spin text-muted-foreground"
          aria-label={t('chat.running')}
        />
      )}
    </Message>
  );
});
