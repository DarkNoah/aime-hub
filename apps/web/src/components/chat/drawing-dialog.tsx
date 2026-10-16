import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { TLEditorSnapshot } from 'tldraw';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type DrawingDialogProps = {
  initialSnapshot?: TLEditorSnapshot;
  onComplete: (file: File, snapshot: TLEditorSnapshot) => boolean;
  onCancel: () => void;
  onRestoreFocus: () => void;
};

export function DrawingDialog({
  onComplete,
  onCancel,
  onRestoreFocus,
  initialSnapshot,
}: DrawingDialogProps) {
  const { t } = useTranslation();
  const [Canvas, setCanvas] =
    useState<typeof import('./drawing-canvas').DrawingCanvas>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    import('./drawing-canvas').then(
      (module) => {
        if (!cancelled) setCanvas(() => module.DrawingCanvas);
      },
      (error: unknown) => {
        if (!cancelled) {
          console.error('Could not load the drawing board', error);
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(52rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        // Escape belongs to tldraw (cancel a stroke, leave text editing, etc.).
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('chat.drawing.title')}</DialogTitle>
          <DialogDescription>{t('chat.drawing.hint')}</DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="absolute top-3 right-3 z-10 rounded-full"
            aria-label={t('chat.drawing.close')}
          >
            <X />
          </Button>
        </DialogClose>
        {Canvas ? (
          <Canvas initialSnapshot={initialSnapshot} onComplete={onComplete} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted/30 p-6">
            <p
              role={failed ? 'alert' : 'status'}
              className="text-sm text-muted-foreground"
            >
              {t(failed ? 'chat.drawing.loadFailed' : 'chat.drawing.loading')}
            </p>
            {failed && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFailed(false);
                  setAttempt((value) => value + 1);
                }}
              >
                {t('chat.retry')}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
