import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  AVATAR_SIZE,
} from '@aime/shared/profile';
import { ImageCropDialog } from '@/components/image-crop-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { UserAvatar } from '@/components/user-avatar';
import { authClient } from '@/features/auth/client';
import { authErrorKey } from '@/features/auth/errors';
import type { ErrorKey } from '@/i18n/config';
import { uploadAvatar } from '../api';

export function ProfileDialog({
  user,
  onClose,
}: {
  user: typeof authClient.$Infer.Session.user;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image ?? '');
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [selection, setSelection] = useState<{
    file: File;
    url: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const submitting = useRef(false);
  const avatar = selection?.url ?? image;
  const changed =
    !!selection || name.trim() !== user.name || image !== (user.image ?? '');
  useEffect(
    () => () => {
      if (selection) URL.revokeObjectURL(selection.url);
    },
    [selection],
  );

  function chooseFile(file?: File) {
    if (!file) return;
    if (!(AVATAR_MIME_TYPES as readonly string[]).includes(file.type)) {
      toast.error(t('errors.avatarInvalid'));
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error(t('errors.avatarTooLarge'));
      return;
    }
    setError(null);
    setCropFile(file);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !changed) return;
    if (!name.trim()) {
      setError('errors.nameRequired');
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      let savedImage = image;
      if (selection) {
        savedImage = await uploadAvatar(selection.file);
        // Retain the uploaded URL if saving the profile fails, so retries do
        // not upload the same file again.
        setImage(savedImage);
        setSelection(null);
      }
      const result = await authClient.updateUser({
        name: name.trim(),
        image: savedImage || null,
      });
      if (result.error) throw result.error;
      // Better Auth invalidates useSession and broadcasts the profile update.
      toast.success(t('personalSettings.profileSaved'));
      onClose();
    } catch (cause) {
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? cause.code
          : null;
      const key =
        code === 'AVATAR_TOO_LARGE'
          ? 'errors.avatarTooLarge'
          : code === 'AVATAR_INVALID'
            ? 'errors.avatarInvalid'
            : authErrorKey(cause, 'errors.profileUpdate');
      setError(key);
      toast.error(t(key));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (cropFile)
    return (
      <ImageCropDialog
        file={cropFile}
        maxBytes={AVATAR_MAX_BYTES}
        maxDimension={AVATAR_SIZE}
        aspect={1}
        circularCrop
        allowOriginal={false}
        title={t('personalSettings.cropAvatar')}
        description={t('personalSettings.cropAvatarHint')}
        onCancel={() => setCropFile(null)}
        onConfirm={(file) => {
          setSelection({ file, url: URL.createObjectURL(file) });
          setCropFile(null);
        }}
      />
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh]" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{t('personalSettings.editProfile')}</DialogTitle>
          <DialogDescription>
            {t('personalSettings.profileHint')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="min-h-0 space-y-5">
          <ScrollArea
            viewportProps={{ className: 'max-h-[55dvh] [&>div]:block!' }}
          >
            <fieldset disabled={pending} className="space-y-5 p-1">
              <div className="flex flex-wrap items-center gap-4">
                <UserAvatar
                  name={name.trim() || user.username || user.email}
                  image={avatar}
                  className="size-16"
                />
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  accept={AVATAR_MIME_TYPES.join(',')}
                  aria-label={t('personalSettings.uploadAvatar')}
                  onChange={(event) => {
                    chooseFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload />
                  {t('personalSettings.uploadAvatar')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!avatar}
                  onClick={() => {
                    setImage('');
                    setSelection(null);
                    setError(null);
                  }}
                >
                  {t('personalSettings.removeAvatar')}
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('personalSettings.avatarHint')}
              </p>
              <div className="space-y-2">
                <Label htmlFor="profile-name">
                  {t('personalSettings.nickname')}
                </Label>
                <Input
                  id="profile-name"
                  name="name"
                  autoComplete="nickname"
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                  aria-invalid={error === 'errors.nameRequired'}
                />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('personalSettings.usernameHint')}
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {t(error)}
                </p>
              )}
            </fieldset>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {t('users.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !changed}>
              {pending && (
                <LoaderCircle className="animate-spin motion-reduce:animate-none" />
              )}
              {t(pending ? 'users.saving' : 'users.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
