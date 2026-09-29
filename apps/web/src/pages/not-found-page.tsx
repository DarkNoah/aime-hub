import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="text-xs tracking-widest text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">{t('notFound.heading')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('notFound.description')}
      </p>
      <Button asChild>
        <Link to="/">{t('notFound.home')}</Link>
      </Button>
    </main>
  );
}
