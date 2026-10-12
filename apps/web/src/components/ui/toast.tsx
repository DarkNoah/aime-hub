import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';
import { toast } from './toast-manager';

// shadcn Base UI Toast, adapted to the existing theme and top-right placement.

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  const { t } = useTranslation();
  return toasts.map((item) => (
    <ToastPrimitive.Root
      key={item.id}
      toast={item}
      swipeDirection={['up', 'right']}
      className="group/toast pointer-events-auto absolute right-0 top-0 w-full origin-top rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none select-none [--gap:0.75rem] [--offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--gap))] [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--offset-y)+var(--toast-swipe-movement-y)))] transition-[transform,opacity] duration-300 data-starting-style:-translate-y-full data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:opacity-0 motion-reduce:transition-none"
    >
      <ToastPrimitive.Content className="flex items-start gap-3 overflow-hidden p-4">
        {item.type === 'success' ? (
          <CircleCheck
            className="mt-0.5 size-4 shrink-0 text-emerald-600"
            aria-hidden
          />
        ) : item.type === 'error' ? (
          <CircleX
            className="mt-0.5 size-4 shrink-0 text-destructive"
            aria-hidden
          />
        ) : (
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <ToastPrimitive.Title className="text-sm font-medium" />
          <ToastPrimitive.Description className="break-words text-sm text-muted-foreground" />
          {item.actionProps && (
            <ToastPrimitive.Action
              render={<Button size="sm" variant="outline" />}
              className="mt-2"
            />
          )}
        </div>
        <ToastPrimitive.Close
          aria-label={t('common.close')}
          render={<Button size="icon-sm" variant="ghost" />}
          className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
        >
          <X aria-hidden />
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}

export function Toaster() {
  const { t } = useTranslation();
  return (
    <ToastPrimitive.Provider toastManager={toast} timeout={8000} limit={4}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          aria-label={t('common.notifications')}
          className="pointer-events-none fixed right-4 top-4 z-[100] w-[calc(100vw-2rem)] max-w-sm outline-none"
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}
