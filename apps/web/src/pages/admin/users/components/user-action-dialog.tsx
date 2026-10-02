import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/password-input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { authClient, isAdmin } from '@/features/auth/client';
import { authErrorKey, validateCredentials } from '@/features/auth/errors';
import type { ErrorKey } from '@/i18n/config';

export type ManagedUser = NonNullable<
  Awaited<ReturnType<typeof authClient.admin.listUsers>>['data']
>['users'][number];
export type UserAction =
  | { kind: 'create' }
  | {
      kind:
        'edit' | 'role' | 'password' | 'ban' | 'unban' | 'revoke' | 'delete';
      user: ManagedUser;
    };

const titles = {
  create: 'users.create',
  edit: 'users.edit',
  role: 'users.changeRole',
  password: 'users.resetPassword',
  ban: 'users.ban',
  unban: 'users.unban',
  revoke: 'users.revoke',
  delete: 'users.delete',
} as const;
const descriptions = {
  create: 'users.createHint',
  edit: 'users.editHint',
  role: 'users.roleHint',
  password: 'users.passwordHint',
  ban: 'users.banHint',
  unban: 'users.unbanHint',
  revoke: 'users.revokeHint',
  delete: 'users.deleteHint',
} as const;

export function UserActionDialog({
  action,
  onClose,
  onSuccess,
  restoreFocus,
}: {
  action: UserAction;
  onClose: () => void;
  onSuccess: () => void;
  restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const user = action.kind === 'create' ? null : action.user;
  const [role, setRole] = useState<'admin' | 'user'>(
    isAdmin(user?.role) ? 'admin' : 'user',
  );
  const [duration, setDuration] = useState('permanent');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const hasPassword = action.kind === 'create' || action.kind === 'password';
  const hasProfile = action.kind === 'create' || action.kind === 'edit';
  const destructive = action.kind === 'delete' || action.kind === 'ban';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') ?? '')
      .trim()
      .toLowerCase();
    const password = String(form.get('password') ?? '');
    if (hasPassword) {
      const validation =
        action.kind === 'create'
          ? validateCredentials(username, password)
          : password.length < 8 || password.length > 128
            ? 'errors.passwordLength'
            : null;
      if (validation) {
        setError(validation);
        return;
      }
      if (password !== form.get('confirmPassword')) {
        setError('errors.passwordMismatch');
        return;
      }
    }
    if (hasProfile && !String(form.get('name') ?? '').trim()) {
      setError('errors.nameRequired');
      return;
    }
    if (action.kind === 'delete' && deleteConfirmation !== action.user.email)
      return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      let response;
      switch (action.kind) {
        case 'create':
          response = await authClient.admin.createUser({
            name: String(form.get('name')).trim(),
            email: String(form.get('email')).trim(),
            password,
            role,
            data: { username, displayUsername: username },
          });
          break;
        case 'edit':
          response = await authClient.admin.updateUser({
            userId: action.user.id,
            data: {
              name: String(form.get('name')).trim(),
              email: String(form.get('email')).trim(),
            },
          });
          break;
        case 'role':
          response = await authClient.admin.setRole({
            userId: action.user.id,
            role,
          });
          break;
        case 'password':
          response = await authClient.admin.setUserPassword({
            userId: action.user.id,
            newPassword: password,
          });
          break;
        case 'ban':
          response = await authClient.admin.banUser({
            userId: action.user.id,
            banReason: String(form.get('reason') ?? '').trim() || undefined,
            banExpiresIn:
              duration === 'permanent' ? undefined : Number(duration) * 86400,
          });
          break;
        case 'unban':
          response = await authClient.admin.unbanUser({
            userId: action.user.id,
          });
          break;
        case 'revoke':
          response = await authClient.admin.revokeUserSessions({
            userId: action.user.id,
          });
          break;
        case 'delete':
          response = await authClient.admin.removeUser({
            userId: action.user.id,
          });
          break;
      }
      if (response.error) {
        toast.error(t(authErrorKey(response.error)));
        return;
      }
      onSuccess();
    } catch (cause) {
      toast.error(t(authErrorKey(cause)));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        className="max-h-[90dvh] overflow-y-auto"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t(titles[action.kind])}</DialogTitle>
          <DialogDescription>{t(descriptions[action.kind])}</DialogDescription>
        </DialogHeader>
        {user && (
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <p className="break-words font-medium">{user.name}</p>
            <p className="break-all text-muted-foreground">{user.email}</p>
          </div>
        )}
        <form onSubmit={submit} className="space-y-5">
          <fieldset disabled={pending} className="space-y-4">
            {action.kind === 'create' && (
              <div className="space-y-2">
                <Label htmlFor="user-username">{t('auth.username')}</Label>
                <Input
                  id="user-username"
                  name="username"
                  required
                  minLength={3}
                  maxLength={30}
                  pattern="[a-zA-Z0-9_.]+"
                  title={t('auth.usernameTitle')}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  {t('auth.usernameHint')}
                </p>
              </div>
            )}
            {hasProfile && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="user-name">{t('users.name')}</Label>
                  <Input
                    id="user-name"
                    name="name"
                    required
                    maxLength={200}
                    defaultValue={user?.name ?? ''}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-email">{t('auth.email')}</Label>
                  <Input
                    id="user-email"
                    name="email"
                    type="email"
                    required
                    defaultValue={user?.email ?? ''}
                    autoComplete="off"
                  />
                </div>
              </>
            )}
            {(action.kind === 'create' || action.kind === 'role') && (
              <div className="space-y-2">
                <Label htmlFor="user-role">{t('users.role')}</Label>
                <Select
                  value={role}
                  onValueChange={(value) => setRole(value as 'admin' | 'user')}
                  disabled={pending}
                >
                  <SelectTrigger id="user-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">{t('users.user')}</SelectItem>
                    <SelectItem value="admin">{t('users.admin')}</SelectItem>
                  </SelectContent>
                </Select>
                {role === 'admin' && (
                  <p className="text-xs text-muted-foreground">
                    {t('users.adminHint')}
                  </p>
                )}
              </div>
            )}
            {hasPassword && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="user-password">{t('auth.password')}</Label>
                  <PasswordInput
                    id="user-password"
                    name="password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    placeholder={t('auth.newPasswordPlaceholder')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-confirm-password">
                    {t('auth.confirmPassword')}
                  </Label>
                  <PasswordInput
                    id="user-confirm-password"
                    name="confirmPassword"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                </div>
              </>
            )}
            {action.kind === 'ban' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="user-reason">{t('users.banReason')}</Label>
                  <Input id="user-reason" name="reason" maxLength={500} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-duration">
                    {t('users.banDuration')}
                  </Label>
                  <Select
                    value={duration}
                    onValueChange={setDuration}
                    disabled={pending}
                  >
                    <SelectTrigger id="user-duration" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="permanent">
                        {t('users.permanent')}
                      </SelectItem>
                      <SelectItem value="1">{t('users.oneDay')}</SelectItem>
                      <SelectItem value="7">{t('users.sevenDays')}</SelectItem>
                      <SelectItem value="30">
                        {t('users.thirtyDays')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            {action.kind === 'delete' && (
              <div className="space-y-2">
                <Label htmlFor="user-delete-confirm">
                  {t('users.deleteConfirm')}
                </Label>
                <Input
                  id="user-delete-confirm"
                  type="email"
                  required
                  autoComplete="off"
                  value={deleteConfirmation}
                  onChange={(event) =>
                    setDeleteConfirmation(event.target.value)
                  }
                />
              </div>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={onClose}>
              {t('users.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                (action.kind === 'delete' && deleteConfirmation !== user?.email)
              }
              className={
                destructive
                  ? 'bg-destructive text-white hover:bg-destructive/90'
                  : undefined
              }
            >
              {pending && <Loader2 className="animate-spin" />}
              {pending
                ? t('users.saving')
                : t(
                    action.kind === 'create'
                      ? 'users.create'
                      : action.kind === 'edit' || action.kind === 'role'
                        ? 'users.save'
                        : titles[action.kind],
                  )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
