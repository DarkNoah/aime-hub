import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AVATAR_MAX_BYTES, AVATAR_MIME_TYPES } from '@aime/shared/profile';
import { Button } from '@/components/ui/button';
import { RoomAgentAvatarGenerator } from './room-agent-avatar-generator';
import { RoomAgentAvatar } from './room-agent-avatar';

const imageTypes: readonly string[] = [...AVATAR_MIME_TYPES, 'image/gif'];

export function RoomAgentAvatarEditor({
  roomId,
  agentId,
  name,
  image,
  disabled,
  onChange,
}: {
  roomId: string;
  agentId: string;
  name: string;
  image?: string;
  disabled: boolean;
  onChange: (file: File) => void;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  function select(file?: File) {
    if (!file) return false;
    if (!file.size || !imageTypes.includes(file.type)) {
      toast.error(t('groupChat.avatarInvalid'));
      return false;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error(t('errors.avatarTooLarge'));
      return false;
    }
    setPreviewUrl(URL.createObjectURL(file));
    onChange(file);
    return true;
  }

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 border-b pb-5">
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
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              <Upload aria-hidden="true" />
              {t('groupChat.avatarUpload')}
            </Button>
            <RoomAgentAvatarGenerator
              roomId={roomId}
              agentId={agentId}
              onSelect={select}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('groupChat.avatarFormats')}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
