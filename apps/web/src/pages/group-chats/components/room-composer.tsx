import { useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowUp } from 'lucide-react';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputSubmit,
} from '@/components/ai-elements/prompt-input';
import { useChatDraft } from '@/components/chat/use-chat-draft';
import { groupChatErrorKey } from '../api';

export function RoomComposer({
  roomId,
  userId,
  onSend,
}: {
  roomId: string;
  userId: string;
  onSend: (id: string, text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { text, setText, clear } = useChatDraft({
    userId,
    groupChatId: roomId,
  });
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const retry = useRef<{ id: string; text: string } | null>(null);
  return (
    <div className="pointer-events-auto mx-auto w-full max-w-3xl px-4 pb-4">
      <PromptInput
        onSubmit={async ({ text: draft }) => {
          if (busy.current || !draft.trim()) throw new Error('Unavailable');
          const attempt =
            retry.current?.text === draft
              ? retry.current
              : { id: nanoid(), text: draft };
          retry.current = attempt;
          busy.current = true;
          setPending(true);
          try {
            await onSend(attempt.id, draft);
            clear(draft);
            retry.current = null;
          } catch (cause) {
            toast.error(t(groupChatErrorKey(cause)));
            throw cause;
          } finally {
            busy.current = false;
            setPending(false);
          }
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('groupChat.placeholder')}
            aria-label={t('groupChat.placeholder')}
            maxLength={20_000}
            disabled={pending}
            onPaste={(event) => {
              if (event.clipboardData.files.length) event.preventDefault();
            }}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <span className="text-xs text-muted-foreground">
            {t('groupChat.sendHint')}
          </span>
          <PromptInputSubmit
            disabled={pending || !text.trim()}
            status={pending ? 'submitted' : 'ready'}
            aria-label={t('groupChat.send')}
            title={t('groupChat.send')}
          >
            <ArrowUp />
          </PromptInputSubmit>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
