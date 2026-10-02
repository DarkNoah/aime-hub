import type { ComponentProps } from 'react';
import { GripVertical } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { cn } from '@/lib/utils';

export function ResizablePanelGroup({
  className,
  ...props
}: ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full min-h-0 min-w-0', className)}
      {...props}
    />
  );
}

export const ResizablePanel = Panel;

export function ResizableHandle({
  className,
  ...props
}: ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px items-center justify-center bg-border outline-none after:absolute after:inset-y-0 after:-left-1 after:w-2 hover:bg-primary focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring data-[separator=active]:bg-primary',
        className,
      )}
      {...props}
    >
      <span className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border bg-muted">
        <GripVertical className="size-3" aria-hidden="true" />
      </span>
    </Separator>
  );
}
