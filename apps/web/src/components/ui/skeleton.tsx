import type { ComponentProps } from 'react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Skeleton({
  asChild = false,
  className,
  ...props
}: ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="skeleton"
      className={cn(
        'animate-pulse rounded-md bg-accent motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}
