import type { UIMessage } from 'ai';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MessageAction,
  MessageActions,
} from '@/components/ai-elements/message';

function messageDate(metadata: UIMessage['metadata']) {
  if (!metadata || typeof metadata !== 'object' || !('createdAt' in metadata))
    return;
  const value = metadata.createdAt;
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  )
    return;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function ChatMessageActions({
  message,
  streaming,
}: {
  message: UIMessage;
  streaming: boolean;
}) {
  const { t, i18n } = useTranslation();
  const isUser = message.role === 'user';
  if (!isUser && (message.role !== 'assistant' || streaming)) return null;

  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const date = isUser ? messageDate(message.metadata) : undefined;
  const canCopy = text.trim().length > 0;
  if (!canCopy && !date) return null;

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('chat.copied'));
    } catch {
      toast.error(t('chat.copyFailed'));
    }
  }

  return (
    <MessageActions className="text-muted-foreground group-[.is-user]:justify-end">
      {date && (
        <time
          dateTime={date.toISOString()}
          title={date.toLocaleString(i18n.language, {
            dateStyle: 'medium',
            timeStyle: 'medium',
          })}
          className="text-xs tabular-nums"
        >
          {date.toLocaleTimeString(i18n.language, {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      )}
      {canCopy && (
        <MessageAction
          className="size-7"
          tooltip={t('chat.copy')}
          label={t('chat.copy')}
          onClick={() => void copyMessage()}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </MessageAction>
      )}
    </MessageActions>
  );
}
