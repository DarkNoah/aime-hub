import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function LoadingState({
  label,
  className,
}: {
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div role="status" className={cn('space-y-4 p-6', className)}>
      <span className="sr-only">{label ?? t('common.loading')}</span>
      <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
        <div className="h-4 w-1/3 rounded bg-muted" />
        <div className="h-10 rounded-md bg-muted/70" />
        <div className="h-10 rounded-md bg-muted/70" />
        <div className="h-10 rounded-md bg-muted/70" />
      </div>
    </div>
  );
}
