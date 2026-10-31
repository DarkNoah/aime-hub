import { IssueBoard } from '@/components/issues/board';
import {
  ArrowRight,
  Clock3,
  Folder,
  MessageSquare,
  Plug,
  Sparkles,
  SquarePen,
  Users,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { NavigationCard } from '@/components/navigation-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/loading-state';
import { isAdmin } from '@/features/auth/client';
import { useAuthSession } from '@/features/auth/session-context';
import { useThreadList } from '@/pages/threads/use-thread-list';

const focusAreas = [
  { label: 'workspace.focusChat', icon: MessageSquare },
  { label: 'workspace.focusProjects', icon: Folder },
  { label: 'workspace.focusAutomations', icon: Clock3 },
] as const;

export function WorkspacePage() {
  const { t, i18n } = useTranslation();
  const { data } = useAuthSession();
  const { threads, loading, error, loadMore } = useThreadList();
  const admin = isAdmin(data?.user.role);
  return (
    <div className="space-y-8">
      <PageHeader
        title={t('workspace.greeting', {
          name: data?.user.name || data?.user.username || t('common.workspace'),
        })}
        description={t('workspace.welcome')}
      />
      <section
        className="workspace-start"
        aria-labelledby="workspace-start-title"
      >
        <div className="min-w-0 max-w-xl">
          <span className="mb-5 inline-flex size-11 items-center justify-center rounded-xl bg-white/10">
            <SquarePen className="size-5" aria-hidden />
          </span>
          <h2
            id="workspace-start-title"
            className="text-2xl leading-snug font-semibold sm:text-3xl"
          >
            {t('workspace.startTitle')}
          </h2>
          <p className="mt-3 max-w-md text-sm leading-7 text-white/80">
            {t('workspace.startDescription')}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              asChild
              className="h-10 bg-white px-5 text-[#244b38] hover:bg-white/90"
            >
              <Link to="/threads">
                {t('chat.new')}
                <ArrowRight />
              </Link>
            </Button>
            <Link
              to="/projects"
              className="rounded-md px-3 py-2 text-sm text-white/90 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white"
            >
              {t('workspace.openProjects')}
            </Link>
          </div>
        </div>
        <div className="hidden w-48 shrink-0 space-y-4 border-l border-white/20 pl-7 xl:block">
          {focusAreas.map(({ label, icon: Icon }) => (
            <div
              key={label}
              className="flex items-center gap-3 text-sm text-white/85"
            >
              <Icon className="size-4" aria-hidden />
              {t(label)}
            </div>
          ))}
        </div>
      </section>
      <IssueBoard />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section aria-labelledby="workspace-recent-title" className="min-w-0">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="workspace-recent-title" className="text-base font-semibold">
              {t('workspace.recent')}
            </h2>
            <Badge variant="outline">{t('chat.personal')}</Badge>
          </div>
          <div className="overflow-hidden rounded-xl border bg-card">
            {loading && !threads.length ? (
              <LoadingState />
            ) : error ? (
              <div role="alert" className="space-y-3 p-6 text-sm">
                <p className="text-destructive">{t(error)}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadMore()}
                >
                  {t('session.retry')}
                </Button>
              </div>
            ) : threads.length ? (
              <ul className="divide-y">
                {threads.slice(0, 4).map((thread) => (
                  <li key={thread.id}>
                    <Link
                      to="/threads/$threadId"
                      params={{ threadId: thread.id }}
                      className="navigation-card group"
                    >
                      <MessageSquare
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-medium">
                          {thread.title || t('chat.new')}
                        </h3>
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          {new Date(thread.updatedAt).toLocaleDateString(
                            i18n.language,
                            { month: 'short', day: 'numeric' },
                          )}
                        </p>
                      </div>
                      <ArrowRight
                        className="navigation-arrow size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
                <MessageSquare className="size-6 text-primary" aria-hidden />
                <p className="text-sm font-medium">
                  {t('workspace.recentEmpty')}
                </p>
                <p className="max-w-xs text-sm leading-6 text-muted-foreground">
                  {t('workspace.recentEmptyHint')}
                </p>
              </div>
            )}
          </div>
        </section>
        <section aria-labelledby="workspace-explore-title" className="min-w-0">
          <h2
            id="workspace-explore-title"
            className="mb-4 text-base font-semibold"
          >
            {t('workspace.explore')}
          </h2>
          <div className="divide-y overflow-hidden rounded-xl border bg-card">
            <NavigationCard
              to="/projects"
              title={t('nav.projects')}
              description={t('workspace.projectsHint')}
              icon={Folder}
            />
            <NavigationCard
              to="/automations"
              title={t('nav.automations')}
              description={t('workspace.automationsHint')}
              icon={Clock3}
            />
            <NavigationCard
              to="/skills"
              title={t('nav.skills')}
              description={t('workspace.skillsHint')}
              icon={Sparkles}
            />
          </div>
        </section>
      </div>
      {admin && (
        <section
          aria-labelledby="workspace-manage-heading"
          className="border-t pt-6"
        >
          <h2
            id="workspace-manage-heading"
            className="mb-3 text-sm font-semibold text-muted-foreground"
          >
            {t('workspace.quickAccess')}
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            <NavigationCard
              to="/admin/providers"
              title={t('nav.providers')}
              description={t('admin.providersDescription')}
              icon={Plug}
            />
            <NavigationCard
              to="/admin/users"
              title={t('nav.users')}
              description={t('admin.usersDescription')}
              icon={Users}
            />
          </div>
        </section>
      )}
    </div>
  );
}
