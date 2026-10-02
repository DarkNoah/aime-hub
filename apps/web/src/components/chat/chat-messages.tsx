import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { UIMessage } from 'ai';
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
import { groupChatMessages, groupMessageParts } from './messages';

export function ChatMessages({
  messages,
  running,
  activeMessageId,
}: {
  messages: UIMessage[];
  running: boolean;
  activeMessageId: string | null;
}) {
  const rows = groupChatMessages(messages);
  const lastMessageId = messages.at(-1)?.id;
  return rows.map(({ message, sourceIds }) => (
    <ChatMessage
      key={message.id}
      message={message}
      streaming={
        running && !!activeMessageId && sourceIds.includes(activeMessageId)
      }
      showReasoning={sourceIds.includes(lastMessageId ?? '')}
      isLastMessage={sourceIds.includes(lastMessageId ?? '')}
    />
  ));
}

export const ChatMessage = memo(function ChatMessage({
  message,
  streaming,
  showReasoning,
  isLastMessage = false,
}: {
  message: UIMessage;
  streaming: boolean;
  showReasoning: boolean;
  isLastMessage?: boolean;
}) {
  const { t } = useTranslation();
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const lastReasoningIndex = message.parts.reduce(
    (last, part, index) => (part.type === 'reasoning' ? index : last),
    -1,
  );
  return (
    <Message from={message.role} className="w-full min-w-0 max-w-full">
      {streaming && (
        <LoaderCircle
          className="mb-2 size-3 animate-spin text-muted-foreground"
          aria-label={t('chat.running')}
        />
      )}
      <MessageContent className="min-w-0 max-w-full overflow-hidden text-sm leading-7 [overflow-wrap:anywhere] group-[.is-assistant]:w-full">
        {groupMessageParts(message).map((item) => {
          if (item.type === 'tools') {
            return (
              <ChainOfThought
                // Reset the default only when the message becomes history.
                key={`${item.id}:${isLastMessage ? 'last-message' : 'history'}`}
                defaultOpen={isLastMessage}
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
            );
          }
          const { part, index } = item;
          if (part.type === 'text')
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
                <ReasoningContent>{part.text}</ReasoningContent>
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
      {message.role === 'assistant' && text && !streaming && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="mt-1 size-7 text-muted-foreground"
          aria-label={t('chat.copy')}
          title={t('chat.copy')}
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => toast.success(t('chat.copied')))
              .catch(() => toast.error(t('errors.generic')))
          }
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </Button>
      )}
    </Message>
  );
});
