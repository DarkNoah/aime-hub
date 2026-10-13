import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Paperclip, RotateCw, Square } from 'lucide-react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import {
  MAX_CHAT_FILES,
  MAX_IMAGE_BYTES,
  runInputSchema,
  type RunInput,
  type ChatUsage,
  type ChatSettings,
  type ThreadGoal,
} from '@aime/shared/threads';
import {
  Attachment,
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai-elements/attachments';
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
import { AgentSelector } from '@/components/agent-selector';
import { useAvailableAgents } from '@/features/agents/use-available-agents';
import { chatApi, ChatApiError, chatErrorKey } from './api';
import { usePersonalChatSettings } from './use-personal-chat-settings';
import { ChatContextUsage } from './chat-context-usage';
import { ChatCommandTextarea } from './chat-command-textarea';
import { useChatSkills } from './use-chat-skills';
import { skillCommandGroup } from './skill-commands';
import { consumeCompactCommand, consumeGoalCommand } from './slash-command';
import { ChatGoal } from './chat-goal';
import type { GeneratedAsset } from '@aime/shared/assets';
import { useAssetAttachments } from '@/components/generated-assets/context';
import { assetsApi } from '@/components/generated-assets/api';
import { fileErrorKey, filesApi } from '@/components/file-manager/api';
import { useAuthSession } from '@/features/auth/session-context';
import { useChatDraft } from './use-chat-draft';

function GeneratedAttachments({
  assets,
  onChange,
  disabled,
}: {
  assets: GeneratedAsset[];
  onChange: (assets: GeneratedAsset[]) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const context = useAssetAttachments();
  const uploaded = usePromptInputAttachments();
  useEffect(
    () =>
      context?.register((incoming) => {
        if (disabled) {
          toast.error(t('assets.composerUnavailable'));
          return false;
        }
        const next = [
          ...new Map(
            [...assets, ...incoming].map((asset) => [asset.id, asset]),
          ).values(),
        ];
        if (next.length + uploaded.files.length > MAX_CHAT_FILES) {
          toast.error(t('assets.limit', { count: MAX_CHAT_FILES }));
          return false;
        }
        onChange(next);
        return true;
      }),
    [context, assets, uploaded.files.length, onChange, disabled, t],
  );
  if (!assets.length) return null;
  return (
    <Attachments
      variant="inline"
      className="w-full min-w-0 px-3 pt-3"
      aria-label={t('assets.attachments')}
    >
      {assets.map((asset) => (
        <Attachment
          key={asset.id}
          data={{
            type: 'file',
            id: asset.id,
            filename: asset.name,
            mediaType: asset.mimeType,
            url: filesApi.raw(asset.threadId, asset.path),
          }}
          onRemove={() =>
            onChange(assets.filter((item) => item.id !== asset.id))
          }
          className="max-w-full min-w-0"
          tabIndex={0}
        >
          <AttachmentPreview />
          <AttachmentInfo className="max-w-48" />
          <AttachmentRemove
            disabled={disabled}
            label={t('assets.remove', { name: asset.name })}
            className="shrink-0 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </Attachment>
      ))}
    </Attachments>
  );
}

function ComposerAttachments({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <Attachments variant="inline" className="w-full min-w-0 px-3 pt-3">
      {attachments.files.map((file) => (
        <AttachmentHoverCard key={file.id}>
          <AttachmentHoverCardTrigger asChild>
            <Attachment
              data={file}
              onRemove={() => attachments.remove(file.id)}
              className="max-w-full min-w-0"
              tabIndex={0}
            >
              <AttachmentPreview />
              <AttachmentInfo className="max-w-48" />
              <AttachmentRemove
                className="shrink-0 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                disabled={disabled}
                label={t('chat.removeImage')}
              />
            </Attachment>
          </AttachmentHoverCardTrigger>
          <AttachmentHoverCardContent
            side="top"
            className="max-w-[min(20rem,calc(100vw-2rem))]"
          >
            <img
              src={file.url}
              alt={file.filename ?? t('chat.image')}
              className="max-h-64 w-full rounded object-contain"
            />
            <p className="mt-2 break-all text-sm">
              {file.filename ?? t('chat.image')}
            </p>
          </AttachmentHoverCardContent>
        </AttachmentHoverCard>
      ))}
    </Attachments>
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
      className="size-7 @xl/chat:size-8"
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
  goal,
  onClearGoal,
}: {
  className?: string;
  queue?: ReactNode;
  usage?: ChatUsage | null;
  threadId?: string;
  projectId?: string;
  goal?: ThreadGoal | null;
  onClearGoal?: () => Promise<void>;
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
  const agentCatalog = useAvailableAgents();
  const fixedModel = agentCatalog.data?.agents.find(
    (agent) =>
      agent.id === (settings.agentId ?? agentCatalog.data?.defaultAgentId),
  )?.model;
  function changeSettings(value: ChatSettings) {
    void saveSettings(value)
      .then((saved) => {
        if (saved) toast.success(t('chat.saved'), { id: 'chat-preferences' });
      })
      .catch((cause) =>
        toast.error(t(chatErrorKey(cause)), { id: 'chat-preferences' }),
      );
  }
  const { data: session } = useAuthSession();
  const {
    text,
    setText,
    clear: clearDraft,
  } = useChatDraft({
    userId: session?.user.id,
    threadId,
    projectId,
  });
  const [assetAttachments, setAssetAttachments] = useState<GeneratedAsset[]>(
    [],
  );
  const [goalDraft, setGoalDraft] = useState(false);
  const [closingGoal, setClosingGoal] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const skillCatalog = useChatSkills(commandsOpen, threadId, projectId);
  const commandGroups = [
    {
      id: 'builtin',
      sections: [
        {
          id: 'builtin',
          items: [
            {
              id: 'command:compact',
              name: 'compact',
              description: t('chat.compression.command'),
              action: 'compact' as const,
            },
            {
              id: 'command:goal',
              name: 'goal',
              description: t('chat.goal.command'),
              action: 'goal' as const,
            },
          ],
        },
      ],
    },
    skillCommandGroup(
      skillCatalog.skills.filter(
        (skill) => !['goal', 'compact'].includes(skill.name.toLowerCase()),
      ),
      t('chat.commands.skills'),
    ),
  ];
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const retryId = useRef<string | null>(null);
  const unavailable =
    disabled ||
    closingGoal ||
    loadingSettings ||
    savingSettings ||
    !!settingsError;
  const showStop =
    (running || stopping) &&
    !text.trim() &&
    !assetAttachments.length &&
    !!onStop;
  const submitLabel = showStop
    ? t(stopping ? 'chat.stopping' : 'chat.stop')
    : t(running && !goalDraft ? 'chat.queueSend' : 'chat.send');

  async function compact() {
    if (pendingRef.current) return;
    if (!threadId) {
      toast.info(t('chat.compression.noThread'));
      return;
    }
    if (running || stopping) {
      toast.error(t('chat.compression.busy'));
      return;
    }
    if (disabled || closingGoal) return;
    pendingRef.current = true;
    setPending(true);
    const toastId = toast.loading(t('chat.compression.running'));
    try {
      const result = await chatApi.compact(threadId);
      if (result.observed)
        toast.success(t('chat.compression.completed'), { id: toastId });
      else toast.info(t('chat.compression.empty'), { id: toastId });
    } catch (cause) {
      toast.error(t(chatErrorKey(cause)), { id: toastId });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <div
      data-chat-composer
      className={cn(
        'pointer-events-none shrink-0 space-y-2 bg-transparent p-3 @lg/chat:p-5',
        className,
      )}
    >
      <div className="pointer-events-auto">
        {queue}
        <PromptInput
          className="relative [&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:bg-card"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          maxFiles={MAX_CHAT_FILES - assetAttachments.length}
          maxFileSize={MAX_IMAGE_BYTES}
          onError={() => toast.error(t('chat.imageHint'))}
          onSubmitCapture={(event) => {
            const body = consumeCompactCommand(text);
            if (body === null) return;
            // A pasted command follows the same local action path. Bypass
            // PromptInput submission so attachments and the remaining draft survive.
            event.preventDefault();
            event.stopPropagation();
            setText(body);
            void compact();
          }}
          onSubmit={async ({ text: draft, files }) => {
            if (unavailable || stopping || pendingRef.current)
              throw new Error('Unavailable');
            const goalText = consumeGoalCommand(draft);
            const body = (goalText ?? draft).trim();
            const startGoal = goalDraft || goalText !== null;
            if (goalText !== null) {
              setGoalDraft(true);
              setText(goalText);
            }
            if (startGoal && !body) {
              toast.error(t('chat.goal.textRequired'));
              throw new Error('Goal requires text');
            }
            if (!body && !files.length && !assetAttachments.length)
              throw new Error('Empty');
            if (files.length + assetAttachments.length > MAX_CHAT_FILES) {
              toast.error(t('assets.limit', { count: MAX_CHAT_FILES }));
              throw new Error('Too many attachments');
            }
            const id = retryId.current ?? nanoid();
            retryId.current = id;
            pendingRef.current = true;
            setPending(true);
            let preparingAssets = assetAttachments.length > 0;
            try {
              if (preparingAssets && !threadId)
                throw new ChatApiError('THREAD_NOT_FOUND');
              const generated =
                assetAttachments.length && threadId
                  ? await assetsApi.attach(
                      threadId,
                      assetAttachments.map((asset) => asset.id),
                    )
                  : { parts: [] };
              preparingAssets = false;
              const result = runInputSchema.safeParse({
                id,
                ...settings,
                isImmediate: startGoal,
                ...(startGoal ? { goal: true } : {}),
                parts: [
                  ...files,
                  ...generated.parts,
                  ...(body ? [{ type: 'text', text: body }] : []),
                ],
              });
              if (!result.success) {
                toast.error(t('chat.errors.validation'));
                throw new ChatApiError('VALIDATION_ERROR');
              }
              await onSend(result.data);
              clearDraft(goalText ?? draft);
              setAssetAttachments([]);
              setGoalDraft(false);
              retryId.current = null;
            } catch (cause) {
              toast.error(
                t(preparingAssets ? fileErrorKey(cause) : chatErrorKey(cause)),
              );
              throw cause;
            } finally {
              setPending(false);
              pendingRef.current = false;
            }
          }}
        >
          <ComposerAttachments disabled={pending} />
          <GeneratedAttachments
            assets={assetAttachments}
            onChange={setAssetAttachments}
            disabled={pending || !!unavailable || !!stopping}
          />
          <PromptInputBody>
            <ChatCommandTextarea
              value={text}
              groups={commandGroups}
              loading={skillCatalog.loading}
              error={skillCatalog.error}
              onRetry={skillCatalog.retry}
              onOpenChange={setCommandsOpen}
              onCommand={(item) => {
                if (item.action === 'compact') {
                  void compact();
                } else if (item.action === 'goal') {
                  setGoalDraft(goal?.status !== 'active');
                  toast.success(t('chat.goal.enabled'));
                }
              }}
              onValueChange={(value) => {
                const body = consumeGoalCommand(value);
                if (body !== null) {
                  setGoalDraft(goal?.status !== 'active');
                  toast.success(t('chat.goal.enabled'));
                }
                setText(body ?? value);
                retryId.current = null;
              }}
              disabled={pending || disabled || stopping || closingGoal}
              placeholder={t(
                goalDraft
                  ? 'chat.goal.placeholder'
                  : running
                    ? 'chat.queuePlaceholder'
                    : 'chat.placeholder',
              )}
            />
          </PromptInputBody>
          <PromptInputFooter className="flex min-w-0 flex-nowrap items-center gap-1">
            <div className="flex shrink-0 items-center gap-1">
              <AttachButton disabled={pending || !!disabled || !!stopping} />
              {(goalDraft || goal) && (
                <ChatGoal
                  disabled={!!disabled || pending || closingGoal}
                  onClose={() => {
                    if (closingGoal) return;
                    setClosingGoal(true);
                    void (
                      goal && onClearGoal ? onClearGoal() : Promise.resolve()
                    )
                      .then(() => {
                        setGoalDraft(false);
                        toast.success(t('chat.goal.closed'));
                      })
                      .catch((cause) => toast.error(t(chatErrorKey(cause))))
                      .finally(() => setClosingGoal(false));
                  }}
                />
              )}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <div className="w-7 shrink-0 @xl/chat:w-auto @xl/chat:min-w-0 @xl/chat:max-w-24 @xl/chat:flex-1">
                <AgentSelector
                  compact
                  collapseOnNarrow
                  label={t('chat.agent')}
                  value={settings.agentId ?? null}
                  agents={agentCatalog.data?.agents ?? []}
                  defaultAgentId={agentCatalog.data?.defaultAgentId}
                  disabled={
                    pending ||
                    stopping ||
                    running ||
                    unavailable ||
                    agentCatalog.loading ||
                    agentCatalog.error ||
                    goal?.status === 'active'
                  }
                  onValueChange={(agentId) =>
                    changeSettings({ ...settings, agentId })
                  }
                />
              </div>
              <ChatSettingsFields
                value={settings}
                modelOverride={fixedModel}
                onChange={changeSettings}
                disabled={
                  pending || stopping || loadingSettings || !!settingsError
                }
              />
              {agentCatalog.error && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 @xl/chat:size-8"
                  aria-label={t('agents.retry')}
                  title={t('agents.retry')}
                  onClick={agentCatalog.retry}
                >
                  <RotateCw aria-hidden="true" />
                </Button>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {usage && <ChatContextUsage usage={usage} />}
              <PromptInputSubmit
                className="size-7 @xl/chat:size-8"
                disabled={
                  showStop ? stopping : pending || unavailable || stopping
                }
                status={
                  pending ? 'submitted' : showStop ? 'streaming' : 'ready'
                }
                onStop={
                  showStop
                    ? () => {
                        void onStop().catch((cause) =>
                          toast.error(t(chatErrorKey(cause))),
                        );
                      }
                    : undefined
                }
                aria-label={submitLabel}
                title={submitLabel}
              >
                {showStop ? <Square className="size-3" /> : <ArrowUp />}
              </PromptInputSubmit>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
      {settingsError && (
        <div
          role="alert"
          className="pointer-events-auto flex items-center justify-center gap-2 text-xs text-destructive"
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
