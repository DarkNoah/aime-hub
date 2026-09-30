import { ArrowRight, Folder, MessageSquare, Plug, Users } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { isAdmin } from '@/features/auth/client';
import { useAuthSession } from '@/features/auth/session-context';

export function WorkspacePage() {
  const { t } = useTranslation();
  const { data } = useAuthSession();
  const admin = isAdmin(data?.user.role);
  return (
    <div className="space-y-9">
      <PageHeader
        title={t('workspace.greeting', {
          name: data?.user.name || data?.user.username || t('common.workspace'),
        })}
        description={t('workspace.welcome')}
      />
      <Link
        to="/threads"
        className="flex items-center gap-4 rounded-xl border bg-card p-5 transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MessageSquare className="size-6 shrink-0 text-primary" />
        <div className="flex-1">
          <h2 className="font-semibold">{t('chat.new')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('chat.welcomeHint')}
          </p>
        </div>
        <ArrowRight className="size-4" />
      </Link>
      {admin && (
        <section aria-labelledby="workspace-manage-heading">
          <h2
            id="workspace-manage-heading"
            className="mb-4 text-sm font-semibold"
          >
            {t('workspace.quickAccess')}
          </h2>
          <div className="divide-y overflow-hidden rounded-xl border bg-card">
            {(
              [
                {
                  to: '/admin/providers',
                  label: 'nav.providers',
                  description: 'admin.providersDescription',
                  icon: Plug,
                },
                {
                  to: '/admin/users',
                  label: 'nav.users',
                  description: 'admin.usersDescription',
                  icon: Users,
                },
              ] as const
            ).map(({ to, label, description, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="group flex items-center gap-4 p-5 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">{t(label)}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {t(description)}
                  </p>
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
              </Link>
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="workspace-next-heading">
        <h2 id="workspace-next-heading" className="mb-4 text-sm font-semibold">
          {t('workspace.futureFeatures')}
        </h2>
        <div className="grid gap-6 border-t pt-6 sm:grid-cols-2 sm:gap-10">
          {(
            [
              {
                title: 'nav.projects',
                description: 'workspace.projectsDescription',
                icon: Folder,
              },
            ] as const
          ).map(({ title, description, icon: Icon }) => (
            <div key={title}>
              <div className="flex flex-wrap items-center gap-2.5">
                <Icon className="size-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">{t(title)}</h3>
                <StatusBadge>{t('common.comingSoon')}</StatusBadge>
              </div>
              <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">
                {t(description)}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
