import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sheetSides = {
  top: 'inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
  right:
    'inset-y-0 right-0 h-dvh w-3/4 border-l sm:max-w-sm data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
  bottom:
    'inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
  left: 'inset-y-0 left-0 h-dvh w-3/4 border-r sm:max-w-sm data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
};

export function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  closeLabel,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  side?: keyof typeof sheetSides;
  showCloseButton?: boolean;
  closeLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-foreground/25 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-300 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-300"
      />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-background shadow-xl outline-none ease-in-out data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:animate-in data-[state=open]:duration-300',
          sheetSides[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close className="absolute top-5 right-4 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">{closeLabel ?? t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-base font-semibold', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}
