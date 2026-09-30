import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function StatusBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'danger' | 'warning';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium',
        {
          'bg-muted text-muted-foreground': tone === 'neutral',
          'bg-primary/8 text-primary': tone === 'success',
          'bg-destructive/8 text-destructive': tone === 'danger',
          'bg-amber-50 text-amber-800': tone === 'warning',
        },
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
