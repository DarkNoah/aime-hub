import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { Home, LoaderCircle, LogOut } from 'lucide-react';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuthSession } from '@/features/auth/session-context';
import { authClient, isAdmin } from '@/features/auth/client';
import { authErrorKey } from '@/features/auth/errors';
import { cn } from '@/lib/utils';
import { ThreadSidebar } from '@/pages/threads/components/thread-sidebar';
import { ProjectSidebar } from '@/pages/projects/components/project-sidebar';
import { adminNavigation } from './navigation';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { data, refetch } = useAuthSession();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  if (!data) return null;
  const admin = isAdmin(data.user.role);
  const displayName = data.user.username || data.user.name;

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        toast.error(t(authErrorKey(result.error, 'errors.signOut')));
        return;
      }
      await refetch();
      navigate('/login', { replace: true });
    } catch (cause) {
      toast.error(t(authErrorKey(cause, 'errors.signOutCheck')));
    } finally {
      setPending(false);
    }
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex h-10 items-center gap-3 rounded-lg px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
      isActive
        ? 'bg-card font-semibold text-primary ring-1 ring-border'
        : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5 pt-6 pb-8">
        <Brand />
      </div>
      <ScrollArea
        className="min-h-0 flex-1"
        viewportProps={{ className: '[&>div]:block!' }}
      >
        <nav aria-label={t('nav.main')} className="space-y-7 px-3">
          <div className="space-y-1">
            <p className="px-3 pb-2 text-xs font-medium text-muted-foreground">
              {t('common.workspace')}
            </p>
            <NavLink to="/" end className={linkClass} onClick={onNavigate}>
              <Home className="size-4" />
              {t('nav.home')}
            </NavLink>
            <ThreadSidebar onNavigate={onNavigate} />
            <ProjectSidebar onNavigate={onNavigate} />
          </div>
          {admin && (
            <div className="space-y-1">
              <p className="px-3 pb-2 text-xs font-medium text-muted-foreground">
                {t('nav.admin')}
              </p>
              {adminNavigation.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end
                  className={linkClass}
                  onClick={onNavigate}
                >
                  <Icon className="size-4" />
                  {t(label)}
                </NavLink>
              ))}
            </div>
          )}
        </nav>
      </ScrollArea>
      <div className="m-3 mt-5 space-y-3 border-t px-2 pt-4 pb-1">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-card text-sm font-medium text-primary"
            aria-hidden="true"
          >
            {displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={displayName}>
              {displayName}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {admin ? t('nav.adminRole') : t('nav.personalRole')}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          disabled={pending}
          onClick={() => void signOut()}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <LogOut />}
          {pending ? t('nav.signingOut') : t('nav.signOut')}
        </Button>
      </div>
    </div>
  );
}
