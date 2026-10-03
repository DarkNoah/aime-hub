import { ArrowRight, Plug, Users, Settings2, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';

const modules = [
  {
    to: '/admin/skills',
    title: 'nav.skills',
    description: 'admin.skillsDescription',
    icon: Sparkles,
  },
  {
    to: '/admin/providers',
    title: 'nav.providers',
    description: 'admin.providersDescription',
    icon: Plug,
  },
  {
    to: '/admin/users',
    title: 'nav.users',
    description: 'admin.usersDescription',
    icon: Users,
  },
  {
    to: '/admin/settings',
    title: 'nav.settings',
    description: 'admin.settingsDescription',
    icon: Settings2,
  },
] as const;

export function AdminOverviewPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-8">
      <PageHeader
        title={t('nav.overview')}
        description={t('admin.overviewDescription')}
      />
      <section
        aria-label={t('nav.admin')}
        className="divide-y overflow-hidden rounded-xl border bg-card"
      >
        {modules.map(({ to, title, description, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-center gap-4 p-5 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{t(title)}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t(description)}
              </p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
          </Link>
        ))}
      </section>
    </div>
  );
}
