import type { ErrorKey } from '@/i18n/config';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  Folder,
  Home,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Plug,
  Settings2,
  Users,
} from 'lucide-react';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useAuthSession } from '@/lib/session-context';
import { authClient, isAdmin } from '@/lib/auth-client';
import { authErrorKey } from '@/lib/auth-errors';
import { cn } from '@/lib/utils';

const adminNavigation = [
  { to: '/admin', label: 'nav.overview', icon: LayoutDashboard },
  { to: '/admin/providers', label: 'nav.providers', icon: Plug },
  { to: '/admin/users', label: 'nav.users', icon: Users },
  { to: '/admin/settings', label: 'nav.settings', icon: Settings2 },
] as const;

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { data, refetch } = useAuthSession();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  if (!data) return null;
  const admin = isAdmin(data.user.role);
  const displayName = data.user.username || data.user.name;

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError(authErrorKey(result.error, 'errors.signOut'));
        return;
      }
      await refetch();
      navigate('/login', { replace: true });
    } catch (cause) {
      setError(authErrorKey(cause, 'errors.signOutCheck'));
    } finally {
      setPending(false);
    }
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex h-10 items-center gap-3 rounded-lg px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
      isActive
        ? 'bg-accent font-medium text-primary'
        : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5 pt-5 pb-7">
        <Brand />
      </div>
      <nav
        aria-label={t('nav.main')}
        className="flex-1 space-y-7 overflow-y-auto px-3"
      >
        <div className="space-y-1">
          <p className="px-3 pb-2 text-[11px] font-medium tracking-wider text-muted-foreground">
            {t('common.workspace')}
          </p>
          <NavLink to="/" end className={linkClass} onClick={onNavigate}>
            <Home className="size-4" />
            {t('nav.home')}
          </NavLink>
          {[
            { label: t('nav.chats'), icon: MessageSquare },
            { label: t('nav.projects'), icon: Folder },
          ].map(({ label, icon: Icon }) => (
            <div
              key={label}
              aria-disabled="true"
              className="flex h-10 select-none items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground/70"
            >
              <Icon className="size-4" />
              {label}
              <span className="ml-auto rounded border border-border/80 px-1.5 py-0.5 text-[10px]">
                {t('common.comingSoon')}
              </span>
            </div>
          ))}
        </div>
        {admin && (
          <div className="space-y-1">
            <p className="px-3 pb-2 text-[11px] font-medium tracking-wider text-muted-foreground">
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
        {error && (
          <p role="alert" className="text-xs leading-5 text-destructive">
            {t(error)}
          </p>
        )}
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

export function AppLayout() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const title =
    adminNavigation.find((item) => item.to === location.pathname)?.label ??
    'common.workspace';

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main-content"
        className="sr-only z-[60] rounded-lg bg-card p-3 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('nav.skip')}
      </a>
      <aside
        aria-label={t('nav.sidebar')}
        className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r bg-sidebar md:block"
      >
        <Sidebar />
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex h-[73px] items-center gap-3 border-b bg-card/70 px-5 sm:px-8">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label={t('nav.open')}
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetTitle className="sr-only">{t('nav.title')}</SheetTitle>
              <SheetDescription className="sr-only">
                {t('nav.description')}
              </SheetDescription>
              <Sidebar onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="text-sm font-medium">{t(title)}</span>
          <span className="ml-auto rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
            {t('nav.initialVersion')}
          </span>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl px-5 py-9 outline-none sm:px-8 sm:py-12"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
