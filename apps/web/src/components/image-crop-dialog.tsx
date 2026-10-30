import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type PercentCrop,
} from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Crop, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { imageFileFromCanvas } from '@/lib/screenshot';

export function ImageCropDialog({
  file,
  maxBytes,
  aspect,
  circularCrop = false,
  maxDimension,
  allowOriginal = true,
  title,
  description,
  onConfirm,
  onCancel,
}: {
  file: File;
  maxBytes: number;
  aspect?: number;
  circularCrop?: boolean;
  maxDimension?: number;
  allowOriginal?: boolean;
  title?: string;
  description?: string;
  onConfirm: (file: File) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const image = useRef<HTMLImageElement>(null);
  const active = useRef<AbortController | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  // Wait for the image's dimensions before showing a selection, so fixed
  // aspect crops never briefly inherit the generic percentage rectangle.
  const [crop, setCrop] = useState<PercentCrop>();
  // Dialog portals may mount after the parent effect. Bind the preview URL to
  // the actual image lifetime so it also survives StrictMode's ref replay.
  const attachImage = useCallback(
    (element: HTMLImageElement | null) => {
      image.current = element;
      if (!element) return;
      const url = URL.createObjectURL(file);
      element.src = url;
      return () => {
        URL.revokeObjectURL(url);
        image.current = null;
      };
    },
    [file],
  );
  useEffect(() => () => active.current?.abort(), []);

  async function confirm(original: boolean) {
    const element = image.current;
    if (active.current || !element || !size.width || !crop) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      if (original && file.size <= maxBytes && !maxDimension) {
        onConfirm(file);
        return;
      }
      const selection = original
        ? { x: 0, y: 0, width: 100, height: 100 }
        : crop;
      const x = Math.min(
        size.width - 1,
        Math.max(0, Math.round((size.width * selection.x) / 100)),
      );
      const y = Math.min(
        size.height - 1,
        Math.max(0, Math.round((size.height * selection.y) / 100)),
      );
      const canvas = document.createElement('canvas');
      const sourceWidth = Math.max(
        1,
        Math.min(
          size.width - x,
          Math.round((size.width * selection.width) / 100),
        ),
      );
      const sourceHeight = Math.max(
        1,
        Math.min(
          size.height - y,
          Math.round((size.height * selection.height) / 100),
        ),
      );
      const scale = Math.min(
        1,
        (maxDimension ?? Infinity) / Math.max(sourceWidth, sourceHeight),
      );
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not crop image');
      context.drawImage(
        element,
        x,
        y,
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const result = await imageFileFromCanvas(canvas, {
        name: file.name,
        maxBytes,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) onConfirm(result);
    } catch {
      if (!controller.signal.aborted) toast.error(t('imageCrop.failed'));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const ready = size.width > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left sm:px-6 sm:pr-12">
          <DialogTitle>{title ?? t('imageCrop.title')}</DialogTitle>
          <DialogDescription>
            {description ?? t('imageCrop.hint')}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 flex-1 bg-muted/40 p-3 sm:p-6">
          <div className="flex size-full items-center justify-center [container-type:size]">
            <ReactCrop
              className="[--rc-focus-color:var(--ring)] motion-reduce:[&_.ReactCrop__crop-selection]:animate-none"
              style={{
                width: ready
                  ? `min(100cqw, ${(100 * size.width) / size.height}cqh)`
                  : undefined,
              }}
              crop={crop}
              aspect={aspect}
              circularCrop={circularCrop}
              keepSelection={!!aspect}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              disabled={busy || !ready}
              minWidth={8}
              minHeight={8}
              ruleOfThirds
              ariaLabels={{
                cropArea: t('imageCrop.selection'),
                nwDragHandle: t('imageCrop.resize.nw'),
                nDragHandle: t('imageCrop.resize.n'),
                neDragHandle: t('imageCrop.resize.ne'),
                eDragHandle: t('imageCrop.resize.e'),
                seDragHandle: t('imageCrop.resize.se'),
                sDragHandle: t('imageCrop.resize.s'),
                swDragHandle: t('imageCrop.resize.sw'),
                wDragHandle: t('imageCrop.resize.w'),
              }}
            >
              <img
                ref={attachImage}
                alt={t('imageCrop.image')}
                className="block w-full max-w-full"
                onLoad={(event) => {
                  const width = event.currentTarget.naturalWidth;
                  const height = event.currentTarget.naturalHeight;
                  setSize({ width, height });
                  setCrop(
                    aspect
                      ? centerCrop(
                          makeAspectCrop(
                            { unit: '%', width: 80 },
                            aspect,
                            width,
                            height,
                          ),
                          width,
                          height,
                        )
                      : { unit: '%', x: 10, y: 10, width: 80, height: 80 },
                  );
                }}
                onError={() => toast.error(t('imageCrop.failed'))}
              />
            </ReactCrop>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground sm:px-6">
          <span>{t('imageCrop.keyboardHint')}</span>
          {ready && crop && (
            <Badge variant="secondary">
              {Math.round((size.width * crop.width) / 100)} ×{' '}
              {Math.round((size.height * crop.height) / 100)}
            </Badge>
          )}
        </div>
        <DialogFooter className="shrink-0 flex-row flex-wrap justify-end border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('imageCrop.cancel')}
          </Button>
          {allowOriginal && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !ready}
              onClick={() => void confirm(true)}
            >
              {t('imageCrop.original')}
            </Button>
          )}
          <Button
            type="button"
            disabled={busy || !ready || !crop?.width || !crop?.height}
            onClick={() => void confirm(false)}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Crop />}
            {t('imageCrop.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
