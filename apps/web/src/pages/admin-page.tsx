import { useTranslation } from 'react-i18next';
import { Construction, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function AdminPage({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-8">
      <section>
        <p className="mb-3 text-xs font-medium tracking-[0.18em] text-primary">
          {t('admin.eyebrow')}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          {description}
        </p>
      </section>
      <Card className="border-dashed shadow-none">
        <CardContent className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
          <div className="mb-6 flex size-14 items-center justify-center rounded-2xl border bg-background">
            <Icon className="size-6 text-primary" strokeWidth={1.5} />
          </div>
          <h2 className="text-lg font-medium">{t('admin.placeholderTitle')}</h2>
          <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">
            {t('admin.placeholderDescription')}
          </p>
          <span className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            <Construction className="size-3.5" />
            {t('admin.future')}
          </span>
        </CardContent>
      </Card>
    </div>
  );
}
