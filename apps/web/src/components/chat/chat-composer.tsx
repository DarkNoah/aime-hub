import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import {
  MAX_CHAT_FILES,
  MAX_IMAGE_BYTES,
  runInputSchema,
  type ChatSettings,
  type RunInput,
} from '@aime/shared/threads';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChatSettingsFields } from './chat-settings';
import { ChatApiError, chatErrorKey } from './api';

function ComposerAttachments({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const attachments = usePromptInputAttachments();
  return (
    <>
      {attachments.files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.files.map((file) => (
            <div
              key={file.id}
              className="relative size-16 overflow-hidden rounded-md border"
            >
              <img
                src={file.url}
                alt={file.filename ?? t('chat.image')}
                className="size-full object-cover"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="absolute top-0 right-0 size-6"
                disabled={disabled}
                aria-label={t('chat.removeImage')}
                onClick={() => attachments.remove(file.id)}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
function AttachButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const attachments = usePromptInputAttachments();
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      disabled={disabled}
      aria-label={t('chat.attach')}
      title={t('chat.imageHint')}
      onClick={attachments.openFileDialog}
    >
      <Paperclip />
    </Button>
  );
}

export function ChatComposer({
  initialSettings,
  disabled,
  running,
  stopping,
  onSend,
  onStop,
}: {
  initialSettings: ChatSettings;
  disabled?: boolean;
  running?: boolean;
  stopping?: boolean;
  onSend: (input: RunInput) => Promise<void>;
  onStop?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(initialSettings);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const retryId = useRef<string | null>(null);
  const [immediate, setImmediate] = useState(false);
  return (
    <div className="shrink-0 space-y-2 border-t bg-card p-3 @lg/chat:p-5">
      <ChatSettingsFields
        value={settings}
        onChange={setSettings}
        disabled={pending || stopping}
      />
      <PromptInput
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        maxFiles={MAX_CHAT_FILES}
        maxFileSize={MAX_IMAGE_BYTES}
        onError={() => toast.error(t('chat.imageHint'))}
        onSubmit={async ({ text: draft, files }) => {
          if (disabled || stopping || pendingRef.current)
            throw new Error('Unavailable');
          if (!draft.trim() && !files.length) throw new Error('Empty');
          const id = retryId.current ?? nanoid();
          retryId.current = id;
          const result = runInputSchema.safeParse({
            id,
            ...settings,
            isImmediate: immediate,
            parts: [
              ...files,
              ...(draft.trim() ? [{ type: 'text', text: draft.trim() }] : []),
            ],
          });
          if (!result.success) {
            toast.error(t('chat.errors.validation'));
            throw new ChatApiError('VALIDATION_ERROR');
          }
          pendingRef.current = true;
          setPending(true);
          try {
            await onSend(result.data);
            setText('');
            retryId.current = null;
          } catch (cause) {
            toast.error(t(chatErrorKey(cause)));
            throw cause;
          } finally {
            setPending(false);
            pendingRef.current = false;
          }
        }}
      >
        <ComposerAttachments disabled={pending} />
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              retryId.current = null;
            }}
            disabled={pending || disabled || stopping}
            placeholder={t(
              running ? 'chat.queuePlaceholder' : 'chat.placeholder',
            )}
            aria-label={t('chat.message')}
            className="max-h-44 min-h-20"
          />
        </PromptInputBody>
        <PromptInputFooter>
          <div className="flex min-w-0 items-center gap-1">
            <AttachButton disabled={pending || !!disabled || !!stopping} />
            {running && (
              <Select
                value={immediate ? 'immediate' : 'queue'}
                onValueChange={(value) => setImmediate(value === 'immediate')}
              >
                <SelectTrigger
                  aria-label={t('chat.sendMode')}
                  className="h-8 border-0 shadow-none text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="queue">{t('chat.queueSend')}</SelectItem>
                  <SelectItem value="immediate">
                    {t('chat.immediateSend')}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(running || stopping) && onStop && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={stopping}
                onClick={() =>
                  void onStop().catch((cause) =>
                    toast.error(t(chatErrorKey(cause))),
                  )
                }
              >
                <Square className="size-3" />
                {t(stopping ? 'chat.stopping' : 'chat.stop')}
              </Button>
            )}
            <PromptInputSubmit
              disabled={pending || disabled || stopping}
              status={pending ? 'submitted' : 'ready'}
              aria-label={t(running ? 'chat.queueSend' : 'chat.send')}
              title={t('chat.send')}
            >
              <ArrowUp />
            </PromptInputSubmit>
          </div>
        </PromptInputFooter>
      </PromptInput>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        {t(running ? 'chat.backgroundHint' : 'chat.inputHint')}
      </p>
    </div>
  );
}
