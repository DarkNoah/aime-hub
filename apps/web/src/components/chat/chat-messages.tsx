import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { UIMessage } from 'ai';
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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export const ChatMessage = memo(function ChatMessage({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return (
    <Message from={message.role} className="w-full min-w-0 max-w-full">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>{message.role === 'user' ? t('chat.you') : 'Aime'}</span>
        {streaming && (
          <LoaderCircle
            className="size-3 animate-spin"
            aria-label={t('chat.running')}
          />
        )}
      </div>
      <MessageContent className="min-w-0 max-w-full overflow-hidden text-sm leading-7 [overflow-wrap:anywhere] group-[.is-assistant]:w-full">
        {message.parts.map((part, index) => {
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
          if (part.type === 'reasoning' && part.text)
            return (
              <Reasoning
                key={index}
                isStreaming={streaming && part.state === 'streaming'}
                defaultOpen={false}
              >
                <ReasoningTrigger>
                  {t(
                    streaming && part.state === 'streaming'
                      ? 'chat.thinking'
                      : 'chat.reasoning',
                  )}
                </ReasoningTrigger>
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
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
          if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
            const tool = part as {
              type: string;
              toolName?: string;
              state: string;
              input?: unknown;
              output?: unknown;
              errorText?: string;
            };
            const finished = tool.state === 'output-available';
            const failed = tool.state === 'output-error';
            return (
              <details
                key={index}
                className="my-2 rounded-lg border bg-muted/30 px-3 py-2"
              >
                <summary className="flex cursor-pointer items-center gap-2 text-xs">
                  {finished ? (
                    <Check className="size-3.5" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-current" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {tool.toolName ?? tool.type.replace(/^tool-/, '')}
                  </span>
                  <Badge variant={failed ? 'destructive' : 'secondary'}>
                    {t(
                      failed
                        ? 'chat.toolFailed'
                        : finished
                          ? 'chat.toolDone'
                          : 'chat.toolRunning',
                    )}
                  </Badge>
                </summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs">
                  {JSON.stringify(
                    tool.output ?? tool.input ?? tool.errorText ?? {},
                    null,
                    2,
                  )}
                </pre>
              </details>
            );
          }
          return null;
        })}
      </MessageContent>
      {message.role === 'assistant' && text && !streaming && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 text-xs text-muted-foreground"
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => toast.success(t('chat.copied')))
              .catch(() => toast.error(t('errors.generic')))
          }
        >
          <Copy className="size-3" />
          {t('chat.copy')}
        </Button>
      )}
    </Message>
  );
});
