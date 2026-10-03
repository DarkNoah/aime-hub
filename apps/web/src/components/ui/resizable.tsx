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
        'group/resizable-handle relative flex w-px shrink-0 items-center justify-center bg-border outline-none after:absolute hover:bg-primary focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring data-[separator=active]:bg-primary',
        'aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:-left-1 aria-[orientation=vertical]:after:w-2',
        'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:-top-1 aria-[orientation=horizontal]:after:h-2',
        className,
      )}
      {...props}
    >
      <span className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border bg-muted group-aria-[orientation=horizontal]/resizable-handle:h-3 group-aria-[orientation=horizontal]/resizable-handle:w-6">
        <GripVertical
          className="size-3 group-aria-[orientation=horizontal]/resizable-handle:rotate-90"
          aria-hidden="true"
        />
      </span>
    </Separator>
  );
}
