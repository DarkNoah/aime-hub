import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import {
  MAX_CHAT_FILES,
  MAX_IMAGE_BYTES,
  runInputSchema,
  type RunInput,
  type ChatUsage,
} from '@aime/shared/threads';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChatSettingsFields } from './chat-settings';
import { ChatApiError, chatErrorKey } from './api';
import { usePersonalChatSettings } from './use-personal-chat-settings';
import { ChatContextUsage } from './chat-context-usage';
import { ChatCommandTextarea } from './chat-command-textarea';
import { useChatSkills } from './use-chat-skills';
import { skillCommandGroup } from './skill-commands';

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
  className,
  disabled,
  running,
  stopping,
  onSend,
  onStop,
  queue,
  usage,
  threadId,
  projectId,
}: {
  className?: string;
  queue?: ReactNode;
  usage?: ChatUsage | null;
  threadId?: string;
  projectId?: string;
  disabled?: boolean;
  running?: boolean;
  stopping?: boolean;
  onSend: (input: RunInput) => Promise<void>;
  onStop?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const {
    settings,
    loading: loadingSettings,
    saving: savingSettings,
    error: settingsError,
    save: saveSettings,
    retry: retrySettings,
  } = usePersonalChatSettings();
  const [text, setText] = useState('');
  const [commandsOpen, setCommandsOpen] = useState(false);
  const skillCatalog = useChatSkills(commandsOpen, threadId, projectId);
  const commandGroups = [
    skillCommandGroup(skillCatalog.skills, t('chat.commands.skills')),
  ];
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const retryId = useRef<string | null>(null);
  const unavailable =
    disabled || loadingSettings || savingSettings || !!settingsError;
  return (
    <div
      className={cn('shrink-0 space-y-2 bg-card p-3 @lg/chat:p-5', className)}
    >
      <div>
        {queue}
        {usage && (
          <div className="mb-1 flex justify-end">
            <ChatContextUsage usage={usage} />
          </div>
        )}
        <PromptInput
          className="relative [&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:bg-card"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          maxFiles={MAX_CHAT_FILES}
          maxFileSize={MAX_IMAGE_BYTES}
          onError={() => toast.error(t('chat.imageHint'))}
          onSubmit={async ({ text: draft, files }) => {
            if (unavailable || stopping || pendingRef.current)
              throw new Error('Unavailable');
            if (!draft.trim() && !files.length) throw new Error('Empty');
            const id = retryId.current ?? nanoid();
            retryId.current = id;
            const result = runInputSchema.safeParse({
              id,
              ...settings,
              isImmediate: false,
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
            <ChatCommandTextarea
              value={text}
              groups={commandGroups}
              loading={skillCatalog.loading}
              error={skillCatalog.error}
              onRetry={skillCatalog.retry}
              onOpenChange={setCommandsOpen}
              onValueChange={(value) => {
                setText(value);
                retryId.current = null;
              }}
              disabled={pending || disabled || stopping}
              placeholder={t(
                running ? 'chat.queuePlaceholder' : 'chat.placeholder',
              )}
            />
          </PromptInputBody>
          <PromptInputFooter className="items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              <AttachButton disabled={pending || !!disabled || !!stopping} />
              <ChatSettingsFields
                value={settings}
                onChange={(value) => {
                  void saveSettings(value)
                    .then((saved) => {
                      if (saved)
                        toast.success(t('chat.saved'), {
                          id: 'chat-preferences',
                        });
                    })
                    .catch((cause) =>
                      toast.error(t(chatErrorKey(cause)), {
                        id: 'chat-preferences',
                      }),
                    );
                }}
                disabled={
                  pending || stopping || loadingSettings || !!settingsError
                }
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
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
                disabled={pending || unavailable || stopping}
                status={pending ? 'submitted' : 'ready'}
                aria-label={t(running ? 'chat.queueSend' : 'chat.send')}
                title={t('chat.send')}
              >
                <ArrowUp />
              </PromptInputSubmit>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
      {settingsError && (
        <div
          role="alert"
          className="flex items-center justify-center gap-2 text-xs text-destructive"
        >
          <span>{t(settingsError)}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void retrySettings()}
          >
            {t('providers.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
