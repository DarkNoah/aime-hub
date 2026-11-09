import { BrandMark } from '@/components/brand-mark';
import { defaultSystemSettings } from '@aime/shared/system-settings';
import { cn } from '@/lib/utils';

export function Brand({
  className,
  appName = defaultSystemSettings.appName,
}: {
  className?: string;
  appName?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground dark:bg-secondary dark:text-primary">
        <BrandMark />
      </span>
      <span
        className="min-w-0 truncate text-lg font-bold tracking-tight"
        title={appName}
      >
        {appName}
      </span>
    </div>
  );
}
