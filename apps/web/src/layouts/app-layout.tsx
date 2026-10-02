import { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router';
import { ChevronRight, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { LoadingState } from '@/components/loading-state';
import { useAuthSession } from '@/features/auth/session-context';
import { ThreadListProvider } from '@/pages/threads/thread-list-provider';
import { ProjectNavigationProvider } from '@/pages/projects/navigation-provider';
import { PersonalChatSettingsProvider } from '@/components/chat/personal-chat-settings-provider';
import { ThreadNavigationProvider } from '@/components/chat/thread-navigation-provider';
import { Sidebar } from './sidebar';
import { adminNavigation } from './navigation';

export function AppLayout() {
  const { data } = useAuthSession();
  return (
    <PersonalChatSettingsProvider>
      <ThreadListProvider key={data?.session.id}>
        <ProjectNavigationProvider>
          <ThreadNavigationProvider>
            <LayoutContent />
          </ThreadNavigationProvider>
        </ProjectNavigationProvider>
      </ThreadListProvider>
    </PersonalChatSettingsProvider>
  );
}

function LayoutContent() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const isProject = location.pathname.startsWith('/projects');
  const isChat =
    location.pathname.startsWith('/threads') ||
    /^\/projects\/[^/]+\/threads(?:\/|$)/.test(location.pathname);
  const title =
    (isProject
      ? 'nav.projects'
      : isChat
        ? 'nav.chats'
        : adminNavigation.find((item) => item.to === location.pathname)
            ?.label) ?? 'nav.home';

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
        className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r bg-sidebar md:block"
      >
        <Sidebar />
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex h-16 items-center gap-3 border-b bg-card px-5 sm:px-8">
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
            <SheetContent
              side="left"
              closeLabel={t('nav.close')}
              className="w-72 max-w-[calc(100vw-2rem)] gap-0 bg-sidebar"
            >
              <SheetTitle className="sr-only">{t('nav.title')}</SheetTitle>
              <SheetDescription className="sr-only">
                {t('nav.description')}
              </SheetDescription>
              <Sidebar onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="hidden text-muted-foreground sm:inline">
              {t(
                location.pathname.startsWith('/admin')
                  ? 'nav.admin'
                  : 'common.workspace',
              )}
            </span>
            <ChevronRight
              className="hidden size-3.5 text-muted-foreground sm:block"
              aria-hidden="true"
            />
            <span className="truncate font-medium">{t(title)}</span>
          </div>
          <span className="ml-auto hidden rounded-md bg-muted px-2.5 py-1 text-xs sm:inline-block text-muted-foreground">
            {t('nav.initialVersion')}
          </span>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className={
            isChat
              ? 'h-[calc(100dvh-4rem)] min-h-0 w-full outline-none'
              : 'mx-auto w-full max-w-[1440px] px-5 py-7 outline-none sm:px-8 lg:px-10 lg:py-9'
          }
        >
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
