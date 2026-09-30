import { ArrowUpRight, Settings2 } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/status-badge';

export function AdminSettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-8">
      <PageHeader
        title={t('nav.settings')}
        description={t('admin.settingsDescription')}
      />
      <section className="flex flex-col items-center rounded-xl border bg-card px-6 py-16 text-center">
        <span className="mb-5 flex size-12 items-center justify-center rounded-xl bg-muted text-primary">
          <Settings2 className="size-6" strokeWidth={1.5} />
        </span>
        <StatusBadge>{t('common.comingSoon')}</StatusBadge>
        <h2 className="mt-4 text-lg font-semibold">
          {t('admin.settingsTitle')}
        </h2>
        <p className="mt-2 max-w-md text-sm leading-7 text-muted-foreground">
          {t('admin.settingsHint')}
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link to="/admin/providers">
            {t('defaults.title')}
            <ArrowUpRight />
          </Link>
        </Button>
      </section>
    </div>
  );
}
