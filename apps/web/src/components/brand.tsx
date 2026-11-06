import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/lib/utils';

export function Brand({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground dark:bg-secondary dark:text-primary">
        <BrandMark />
      </span>
      <span className="text-lg font-bold tracking-tight whitespace-nowrap">
        aime hub
      </span>
    </div>
  );
}
