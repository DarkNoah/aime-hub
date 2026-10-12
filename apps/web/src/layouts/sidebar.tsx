import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useState } from 'react';
import { nanoid } from 'nanoid';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronsUpDown,
  Clock3,
  Home,
  LoaderCircle,
  LogOut,
  Settings2,
  Sparkles,
  SquarePen,
} from 'lucide-react';
import { Brand } from '@/components/brand';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Item } from '@/components/ui/item';
import { useAuthSession } from '@/features/auth/session-context';
import { authClient, isAdmin } from '@/features/auth/client';
import { authErrorKey } from '@/features/auth/errors';
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
      void navigate({ to: '/login', replace: true });
    } catch (cause) {
      toast.error(t(authErrorKey(cause, 'errors.signOutCheck')));
    } finally {
      setPending(false);
    }
  }

  const linkClass =
    'flex h-10 items-center gap-3 rounded-lg px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring';
  const activeProps = {
    className: 'bg-card font-semibold text-primary ring-1 ring-border',
  };
  const inactiveProps = {
    className: 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
  };

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
          <Item
            asChild
            variant="ghost"
            className="h-10 w-full gap-3 px-3 py-0 text-primary"
          >
            <button
              type="button"
              onClick={() => {
                void navigate({
                  to: '/threads',
                  search: { draft: nanoid() },
                });
                onNavigate?.();
              }}
            >
              <SquarePen className="size-4" />
              <span className="font-medium">{t('chat.new')}</span>
            </button>
          </Item>
          <div className="space-y-1">
            <p className="px-3 pb-2 text-xs font-medium text-muted-foreground">
              {t('common.workspace')}
            </p>
            <Link
              to="/"
              activeOptions={{ exact: true }}
              className={linkClass}
              activeProps={activeProps}
              inactiveProps={inactiveProps}
              onClick={onNavigate}
            >
              <Home className="size-4" />
              {t('nav.home')}
            </Link>
            <Link
              to="/automations"
              className={linkClass}
              activeProps={activeProps}
              inactiveProps={inactiveProps}
              onClick={onNavigate}
            >
              <Clock3 className="size-4" />
              {t('nav.automations')}
            </Link>
            <Link
              to="/skills"
              className={linkClass}
              activeProps={activeProps}
              inactiveProps={inactiveProps}
              onClick={onNavigate}
            >
              <Sparkles className="size-4" />
              {t('nav.skills')}
            </Link>
            <ThreadSidebar onNavigate={onNavigate} />
            <ProjectSidebar onNavigate={onNavigate} />
          </div>
          {admin && (
            <div className="space-y-1">
              <p className="px-3 pb-2 text-xs font-medium text-muted-foreground">
                {t('nav.admin')}
              </p>
              {adminNavigation.map(({ to, label, icon: Icon }) => (
                <Link
                  key={to}
                  to={to}
                  activeOptions={{ exact: true }}
                  className={linkClass}
                  activeProps={activeProps}
                  inactiveProps={inactiveProps}
                  onClick={onNavigate}
                >
                  <Icon className="size-4" />
                  {t(label)}
                </Link>
              ))}
            </div>
          )}
        </nav>
      </ScrollArea>
      <div className="m-3 mt-5 border-t pt-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 data-[state=open]:bg-accent/70"
              aria-label={t('nav.accountMenu')}
              disabled={pending}
            >
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-card text-sm font-medium text-primary"
                aria-hidden="true"
              >
                {displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-sm font-medium"
                  title={displayName}
                >
                  {displayName}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {admin ? t('nav.adminRole') : t('nav.personalRole')}
                </span>
              </span>
              {pending ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="end"
            sideOffset={8}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-48"
          >
            <DropdownMenuItem asChild>
              <Link to="/settings" onClick={onNavigate}>
                <Settings2 />
                {t('nav.personalSettings')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => void signOut()}
            >
              <LogOut />
              {pending ? t('nav.signingOut') : t('nav.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
