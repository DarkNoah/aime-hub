import { Fragment, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, ScanText } from 'lucide-react';
import { isToolUIPart, type UIMessage } from 'ai';
import type { ToolInteraction, ToolResponse } from '@aime/shared/threads';
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
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import { Shimmer } from '@/components/ai-elements/shimmer';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';
import { ChatBackgroundTask } from './chat-background-task';
import { ChatMessageActions } from './chat-message-actions';
import { ChatMessageAttachments } from './chat-message-attachments';
import { splitMessageAttachments } from './message-attachments';
import { ChatMessageCompression } from './chat-message-compression';
import { ChatToolAttachments } from './chat-tool-attachments';
import { ChatToolRenderer } from './tool-renderers';
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
      {rows.map(({ message, sourceIds, parts, elapsedMs }) => (
        <ChatMessage
          key={message.id}
          message={message}
          threadId={threadId}
          parts={parts}
          elapsedMs={elapsedMs}
          streaming={
            running && !!activeMessageId && sourceIds.includes(activeMessageId)
          }
          showReasoning={sourceIds.includes(lastMessageId ?? '')}
          isLastMessage={sourceIds.includes(lastMessageId ?? '')}
          toolInteractions={toolInteractions}
          onToolResponse={onToolResponse}
          disabled={disabled}
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
  showReasoning,
  isLastMessage = false,
  toolInteractions = [],
  onToolResponse,
  disabled,
}: {
  message: UIMessage;
  threadId?: string;
  parts?: ChatMessagePart[];
  elapsedMs?: number;
  streaming: boolean;
  showReasoning: boolean;
  isLastMessage?: boolean;
  toolInteractions?: ToolInteraction[];
  onToolResponse?: (
    interactionId: string,
    response: ToolResponse,
  ) => Promise<void>;
  disabled?: boolean;
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
    groupedParts.length === 0 &&
    !display.attachments.length
  )
    return null;
  const lastReasoningIndex = message.parts.reduce(
    (last, part, index) => (part.type === 'reasoning' ? index : last),
    -1,
  );
  return (
    <Message from={message.role} className="w-full min-w-0 max-w-full">
      {groupedParts.length > 0 && (
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
              return (
                <Fragment key={item.id}>
                  <ChainOfThought
                    // Reset the default only when the message becomes history.
                    key={`${item.id}:${isLastMessage ? 'last-message' : 'history'}`}
                    defaultOpen={false}
                    className="min-w-0"
                  >
                    <ChainOfThoughtHeader>
                      {t('chat.toolGroup', { count: item.tools.length })}
                    </ChainOfThoughtHeader>
                    <ChainOfThoughtContent>
                      {item.tools.map((tool) => (
                        <ChainOfThoughtStep
                          key={tool.toolCallId}
                          status={
                            tool.state.startsWith('output-')
                              ? 'complete'
                              : tool.state === 'input-streaming'
                                ? 'pending'
                                : 'active'
                          }
                          label={
                            <Tool defaultOpen={false} className="mb-0">
                              <ToolHeader
                                {...(tool.type === 'dynamic-tool'
                                  ? { type: tool.type, toolName: tool.toolName }
                                  : { type: tool.type })}
                                state={tool.state}
                                onPreview={
                                  openPreview
                                    ? () => openPreview(tool)
                                    : undefined
                                }
                              />
                              <ToolContent>
                                {tool.input !== undefined && (
                                  <ToolInput input={tool.input} />
                                )}
                                <ToolOutput
                                  output={tool.output}
                                  errorText={tool.errorText}
                                />
                              </ToolContent>
                            </Tool>
                          }
                        />
                      ))}
                    </ChainOfThoughtContent>
                  </ChainOfThought>
                  <ChatToolAttachments tools={item.tools} threadId={threadId} />
                </Fragment>
              );
            }
            const { part, index } = item;
            if (isToolUIPart(part)) {
              const interaction = toolInteractions.find(
                (item) => item.toolCallId === part.toolCallId,
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
            if (
              part.type === 'text' &&
              (part.state !== 'streaming' || !streaming)
            )
              return message.role === 'user' ? (
                <p key={index} className="whitespace-pre-wrap">
                  {part.text}
                </p>
              ) : (
                <MessageResponse key={index} isAnimating={streaming}>
                  {part.text}
                </MessageResponse>
              );
            if (part.type === 'reasoning') {
              if (!showReasoning || index !== lastReasoningIndex) return null;
              const isReasoningStreaming =
                streaming && part.state === 'streaming';
              if (!part.text && !isReasoningStreaming) return null;
              return (
                <Reasoning
                  // Reset expansion for a new stream or completed history, not for every text delta.
                  key={`reasoning-${index}-${isReasoningStreaming ? 'streaming' : 'complete'}`}
                  isStreaming={isReasoningStreaming}
                  defaultOpen={isReasoningStreaming}
                >
                  <ReasoningTrigger
                    getThinkingMessage={(active) =>
                      active ? (
                        <Shimmer duration={1}>{t('chat.thinking')}</Shimmer>
                      ) : (
                        t('chat.reasoning')
                      )
                    }
                  />
                  <ReasoningContent maxHeight={100}>
                    {part.text}
                  </ReasoningContent>
                </Reasoning>
              );
            }
            if (part.type === 'file' && part.mediaType.startsWith('image/'))
              return (
                <img
                  key={index}
                  src={part.url}
                  alt={part.filename ?? t('chat.image')}
                  loading="lazy"
                  className="max-h-72 max-w-full rounded-lg object-contain"
                />
              );
            return null;
          })}
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
      {streaming && (
        <LoaderCircle
          className="mb-2 size-3 animate-spin text-muted-foreground"
          aria-label={t('chat.running')}
        />
      )}
    </Message>
  );
});
