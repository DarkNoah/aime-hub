import { Layers2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Brand({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Layers2 className="size-5" aria-hidden="true" />
      </span>
      <span className="text-lg font-semibold tracking-tight">
        aime
        <span className="ml-1.5 font-normal text-muted-foreground">hub</span>
      </span>
    </div>
  );
}
