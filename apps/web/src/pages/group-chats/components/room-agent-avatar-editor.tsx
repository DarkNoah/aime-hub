import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Sparkles, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES } from '@aime/shared/profile';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorCode } from '@/lib/rpc';
import { groupChatApi, groupChatErrorKey } from '../api';
import { RoomAgentAvatar } from './room-agent-avatar';

const imageTypes: readonly string[] = [...AVATAR_MIME_TYPES, 'image/gif'];

export function RoomAgentAvatarEditor({
  roomId,
  agentId,
  name,
  image,
  disabled,
  generating,
  onGeneratingChange,
  onChange,
}: {
  roomId: string;
  agentId: string;
  name: string;
  image?: string;
  disabled: boolean;
  generating: boolean;
  onGeneratingChange: (generating: boolean) => void;
  onChange: (file: File) => void;
}) {
  const { t } = useTranslation();
  const promptId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const [prompt, setPrompt] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => () => active.current?.abort(), []);
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
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
    setPreviewUrl(URL.createObjectURL(file));
    onChange(file);
  }

  async function generate() {
    if (disabled || active.current || !prompt.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    onGeneratingChange(true);
    try {
      const file = await groupChatApi.generateAgentAvatar(
        roomId,
        agentId,
        prompt.trim(),
        controller.signal,
      );
      if (!controller.signal.aborted) select(file);
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(t(groupChatErrorKey(error)), {
          description:
            apiErrorCode(error) === 'IMAGE_GENERATION_FAILED' &&
            error instanceof Error
              ? error.message
              : undefined,
        });
      }
    } finally {
      active.current = null;
      if (!controller.signal.aborted) onGeneratingChange(false);
    }
  }

  return (
    <fieldset
      disabled={disabled || generating}
      className="min-w-0 space-y-3 border-b pb-5"
    >
      <legend className="mb-2 text-sm font-medium">
        {t('groupChat.agentAvatar')}
      </legend>
      <div className="flex items-center gap-3">
        <RoomAgentAvatar
          name={name}
          image={previewUrl ?? image}
          className="size-14 border [&_svg]:size-7"
        />
        <div className="min-w-0 space-y-1.5">
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
            type="button"
            variant="outline"
            size="sm"
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
      <div className="space-y-2">
        <Label htmlFor={promptId}>{t('groupChat.avatarPrompt')}</Label>
        <div className="flex flex-wrap items-end gap-2">
          <Textarea
            id={promptId}
            value={prompt}
            rows={2}
            maxLength={32000}
            className="field-sizing-fixed min-h-14 min-w-36 flex-1 resize-y"
            placeholder={t('groupChat.avatarPromptExample')}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!prompt.trim()}
            onClick={() => void generate()}
          >
            {generating ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles aria-hidden="true" />
            )}
            {t(
              generating
                ? 'groupChat.avatarGenerating'
                : 'groupChat.avatarGenerate',
            )}
          </Button>
        </div>
      </div>
    </fieldset>
  );
}
