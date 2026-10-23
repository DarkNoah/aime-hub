import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { TLEditorSnapshot } from 'tldraw';
import type { ImageEditSource } from '@/components/image-viewer/image-edit-context';
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
  image?: ImageEditSource;
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
  image,
}: DrawingDialogProps) {
  const { t } = useTranslation();
  const [Canvas, setCanvas] =
    useState<typeof import('./drawing-canvas').DrawingCanvas>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [actionsContainer, setActionsContainer] =
    useState<HTMLDivElement | null>(null);

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
        <DialogHeader
          className={image ? 'gap-1 border-b px-4 py-3 text-left' : 'sr-only'}
        >
          <DialogTitle
            className={image ? 'flex h-8 items-center pr-32' : undefined}
          >
            {t(image ? 'imagePreview.editTitle' : 'chat.drawing.title')}
          </DialogTitle>
          <DialogDescription>
            {t(image ? 'imagePreview.editHint' : 'chat.drawing.hint')}
          </DialogDescription>
        </DialogHeader>
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          <div ref={setActionsContainer} className="flex items-center" />
          <DialogClose asChild>
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="rounded-full"
              aria-label={t('chat.drawing.close')}
            >
              <X />
            </Button>
          </DialogClose>
        </div>
        {Canvas ? (
          <Canvas
            image={image}
            initialSnapshot={initialSnapshot}
            onComplete={onComplete}
            actionsContainer={actionsContainer}
          />
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
