import type { ComponentProps } from 'react';
import { Toggle as TogglePrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Toggle({
  className,
  ...props
}: ComponentProps<typeof TogglePrimitive.Root>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-primary/10 data-[state=on]:text-primary [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}
