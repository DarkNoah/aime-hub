import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Sparkles, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES } from '@aime/shared/profile';
import type { GroupChatAgent } from '@aime/shared/group-chats';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorCode } from '@/lib/rpc';
import { groupChatApi, groupChatErrorKey } from '../api';
import { RoomAgentAvatar } from './room-agent-avatar';

const imageTypes: readonly string[] = [...AVATAR_MIME_TYPES, 'image/gif'];

export function RoomAgentAvatarEditor({
  roomId,
  agent,
  image,
  onSaved,
  onClose,
}: {
  roomId: string;
  agent: GroupChatAgent;
  image?: string;
  onSaved: (agentId: string, url: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const promptId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState<{ file: File; url: string } | null>(null);
  const [pending, setPending] = useState<'generate' | 'save' | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(
    () => () => {
      if (draft) URL.revokeObjectURL(draft.url);
    },
    [draft],
  );

  function select(file?: File) {
    if (!file) return;
    if (!file.size || !imageTypes.includes(file.type)) {
      toast.error(t('groupChat.avatarInvalid'));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error(t('errors.avatarTooLarge'));
      return;
    }
    setDraft({ file, url: URL.createObjectURL(file) });
  }

  async function submit(action: 'generate' | 'save') {
    if (active.current || (action === 'generate' ? !prompt.trim() : !draft))
      return;
    const controller = new AbortController();
    active.current = controller;
    setPending(action);
    try {
      if (action === 'generate') {
        const preview = await groupChatApi.generateAgentAvatar(
          roomId,
          agent.id,
          prompt.trim(),
          controller.signal,
        );
        if (!controller.signal.aborted) select(preview);
      } else if (draft) {
        const { url } = await groupChatApi.saveAgentAvatar(
          roomId,
          agent.id,
          draft.file,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          onSaved(agent.id, url);
          toast.success(t('groupChat.avatarSaved'));
          onClose();
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        switch (apiErrorCode(error)) {
          case 'IMAGE_TOOL_DISABLED':
            toast.error(t('groupChat.avatarToolDisabled'));
            break;
          case 'IMAGE_GENERATION_FAILED':
            toast.error(t('groupChat.avatarGenerateFailed'), {
              description: error instanceof Error ? error.message : undefined,
            });
            break;
          case 'AVATAR_TOO_LARGE':
            toast.error(t('errors.avatarTooLarge'));
            break;
          case 'AVATAR_INVALID':
            toast.error(t('groupChat.avatarInvalid'));
            break;
          default:
            toast.error(t(groupChatErrorKey(error)));
        }
      }
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(null);
    }
  }

  function close() {
    if (pending === 'save') return;
    active.current?.abort();
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
        showCloseButton={pending !== 'save'}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>
            {t('groupChat.editAvatar', { name: agent.name })}
          </DialogTitle>
          <DialogDescription>
            {t('groupChat.avatarDescription')}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0">
          <div className="space-y-5 px-6 py-5">
            <div className="flex items-center gap-4">
              <RoomAgentAvatar
                name={agent.name}
                image={draft?.url ?? image}
                className="size-20 border [&_svg]:size-8"
              />
              <div className="space-y-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept={imageTypes.join(',')}
                  hidden
                  onChange={(event) => {
                    select(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!pending}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload aria-hidden="true" />
                  {t('groupChat.avatarUpload')}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t('groupChat.avatarFormats')}
                </p>
              </div>
            </div>
            <div className="space-y-2 border-t pt-4">
              <Label htmlFor={promptId}>{t('groupChat.avatarPrompt')}</Label>
              <Textarea
                id={promptId}
                value={prompt}
                disabled={!!pending}
                maxLength={32000}
                placeholder={t('groupChat.avatarPromptExample')}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!!pending || !prompt.trim()}
                onClick={() => void submit('generate')}
              >
                {pending === 'generate' ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles aria-hidden="true" />
                )}
                {t(
                  pending === 'generate'
                    ? 'groupChat.avatarGenerating'
                    : 'groupChat.avatarGenerate',
                )}
              </Button>
            </div>
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button
            variant="outline"
            disabled={pending === 'save'}
            onClick={close}
          >
            {t('agents.cancel')}
          </Button>
          <Button
            disabled={!!pending || !draft}
            onClick={() => void submit('save')}
          >
            {t(pending === 'save' ? 'agents.saving' : 'groupChat.avatarSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
