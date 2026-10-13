import {
  BarChart3,
  Bot,
  FileJson2,
  Plug,
  Users,
  Settings2,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { NavigationCard } from '@/components/navigation-card';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';

const modules = [
  {
    to: '/admin/usage',
    title: 'nav.usage',
    description: 'usage.description',
    icon: BarChart3,
  },
  {
    to: '/admin/agents',
    title: 'nav.agents',
    description: 'admin.agentsDescription',
    icon: Bot,
  },
  {
    to: '/admin/request-logs',
    title: 'nav.requestLogs',
    description: 'admin.requestLogsDescription',
    icon: FileJson2,
  },
  {
    to: '/admin/environment-variables',
    title: 'nav.environmentVariables',
    description: 'admin.environmentVariablesDescription',
    icon: TerminalSquare,
  },
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
          <NavigationCard
            key={to}
            to={to}
            title={t(title)}
            description={t(description)}
            icon={Icon}
          />
        ))}
      </section>
    </div>
  );
}
