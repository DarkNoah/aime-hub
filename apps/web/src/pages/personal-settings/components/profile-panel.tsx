import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useAuthSession } from '@/features/auth/session-context';
import { ProfileDialog } from './profile-dialog';

export function ProfilePanel() {
  const { t } = useTranslation();
  const { data } = useAuthSession();
  const [editing, setEditing] = useState(false);
  if (!data) return null;
  const { user } = data;
  const name = user.name || user.username || user.email;

  return (
    <section
      aria-labelledby="profile-title"
      className="rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5 sm:p-6">
        <div>
          <h2 id="profile-title" className="text-lg font-semibold">
            {t('personalSettings.profile')}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t('personalSettings.profileHint')}
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing(true)}>
          <Pencil />
          {t('personalSettings.editProfile')}
        </Button>
      </div>
      <div className="flex items-center gap-4 p-5 sm:p-6">
        <UserAvatar name={name} image={user.image} className="size-16" />
        <div className="min-w-0">
          <p className="truncate font-semibold" title={name}>
            {name}
          </p>
          <p className="mt-1 break-all text-sm text-muted-foreground">
            {user.email}
          </p>
        </div>
      </div>
      <dl className="grid gap-5 px-5 pb-5 text-sm sm:grid-cols-2 sm:px-6 sm:pb-6">
        <div className="min-w-0 space-y-1.5">
          <dt className="text-muted-foreground">
            {t('personalSettings.nickname')}
          </dt>
          <dd className="break-words">{user.name || '—'}</dd>
        </div>
        <div className="min-w-0 space-y-1.5">
          <dt className="text-muted-foreground">{t('auth.username')}</dt>
          <dd className="break-words">{user.username || '—'}</dd>
        </div>
      </dl>
      {editing && (
        <ProfileDialog user={user} onClose={() => setEditing(false)} />
      )}
    </section>
  );
}
