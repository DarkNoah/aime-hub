import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  Tldraw,
  DefaultColorStyle,
  getSnapshot,
  useValue,
  type Editor,
  type TLComponents,
} from 'tldraw';
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite';
import 'tldraw/tldraw.css';
import './drawing-canvas.css';
import { MAX_IMAGE_BYTES } from '@aime/shared/threads';
import { FILE_UPLOAD_MAX_SIZE } from '@aime/shared/files';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/theme/context';
import type { DrawingDialogProps } from './drawing-dialog';
import {
  drawingImageId,
  insertDrawingImage,
  loadDrawingImage,
  protectDrawingImage,
} from './drawing-image';

// Bundle fonts, translations and icons with the app, including offline deployments.
const assetUrls = getAssetUrlsByImport();
const components: TLComponents = { MainMenu: null, PageMenu: null };

export function DrawingCanvas({
  onComplete,
  initialSnapshot,
  image,
  actionsContainer,
}: Pick<DrawingDialogProps, 'onComplete' | 'initialSnapshot' | 'image'> & {
  actionsContainer: HTMLElement | null;
}) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [editor, setEditor] = useState<Editor>();
  const [exporting, setExporting] = useState(false);
  const [imageStatus, setImageStatus] = useState<'loading' | 'ready' | 'error'>(
    image ? 'loading' : 'ready',
  );
  const [imageAttempt, setImageAttempt] = useState(0);
  const active = useRef<AbortController | null>(null);
  const hasShapes = useValue(
    'drawing has shapes',
    () => (editor?.getCurrentPageShapeIds().size ?? 0) > 0,
    [editor],
  );
  const mountEditor = useCallback((mounted: Editor) => {
    mounted.setCurrentTool('draw');
    mounted.focus();
    setEditor(mounted);
  }, []);

  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!editor) return;
    return protectDrawingImage(editor);
  }, [editor]);
  useEffect(() => {
    if (!editor || !image || editor.getShape(drawingImageId)) return;
    const controller = new AbortController();
    editor.updateInstanceState({ isReadonly: true });
    void loadDrawingImage(image, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        editor.updateInstanceState({ isReadonly: false });
        insertDrawingImage(editor, loaded);
        editor.setStyleForNextShapes(DefaultColorStyle, 'red');
        editor.setCurrentTool('draw');
        editor.focus();
        setImageStatus('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setImageStatus('error');
        toast.error(t('imagePreview.editLoadFailed'));
      });
    return () => controller.abort();
  }, [editor, image, imageAttempt, t]);
  useEffect(() => {
    editor?.user.updateUserPreferences({
      colorScheme: resolvedTheme,
      locale: i18n.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
    });
  }, [editor, resolvedTheme, i18n.language]);

  async function complete() {
    if (!editor || active.current || imageStatus !== 'ready') return;
    editor.complete();
    const ids = [...editor.getCurrentPageShapeIds()];
    if (!ids.length) return;
    const snapshot = getSnapshot(editor.store);
    const controller = new AbortController();
    active.current = controller;
    setExporting(true);
    editor.updateInstanceState({ isReadonly: true });
    try {
      // Bound raster dimensions before encoding even a very spread-out canvas.
      const imageBounds = editor.getShapePageBounds(drawingImageId);
      const bounds = (
        imageBounds ?? editor.getShapePageBounds(ids[0])
      )?.clone();
      for (const id of imageBounds ? [] : ids.slice(1)) {
        const next = editor.getShapePageBounds(id);
        if (next) bounds?.union(next);
      }
      let scale = Math.min(
        imageBounds ? 1 : 2,
        4096 /
          Math.max(
            1,
            (bounds?.w ?? 1) + (imageBounds ? 0 : 64),
            (bounds?.h ?? 1) + (imageBounds ? 0 : 64),
          ),
      );
      for (let attempt = 0; attempt < 6; attempt++) {
        const { blob } = await editor.toImage(ids, {
          format: 'png',
          background: !imageBounds,
          ...(imageBounds ? { bounds: imageBounds, padding: 0 } : {}),
          darkMode: false,
          pixelRatio: 1,
          scale,
        });
        controller.signal.throwIfAborted();
        if (
          blob.size > 0 &&
          blob.size <= (imageBounds ? FILE_UPLOAD_MAX_SIZE : MAX_IMAGE_BYTES)
        ) {
          onComplete(
            new File(
              [blob],
              `${imageBounds ? 'annotated' : 'drawing'}-${Date.now()}.png`,
              {
                type: 'image/png',
              },
            ),
            snapshot,
          );
          return;
        }
        scale *= 0.65;
      }
      throw new Error('Drawing exceeds the inline image limit');
    } catch {
      if (!controller.signal.aborted)
        toast.error(t('chat.drawing.exportFailed'));
    } finally {
      if (!controller.signal.aborted) {
        editor.updateInstanceState({ isReadonly: false });
        active.current = null;
        setExporting(false);
      }
    }
  }

  return (
    <div
      className="chat-drawing-canvas relative min-h-0 min-w-0 flex-1"
      style={{ contain: 'layout' }}
    >
      <Tldraw
        snapshot={initialSnapshot}
        assetUrls={assetUrls}
        components={components}
        onMount={mountEditor}
        autoFocus
      />
      {imageStatus !== 'ready' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/95 p-6 text-center">
          <p
            role={imageStatus === 'error' ? 'alert' : 'status'}
            className="text-sm text-muted-foreground"
          >
            {t(
              imageStatus === 'error'
                ? 'imagePreview.editLoadFailed'
                : 'imagePreview.loading',
            )}
          </p>
          {imageStatus === 'error' && (
            <Button
              variant="outline"
              onClick={() => {
                setImageStatus('loading');
                setImageAttempt((value) => value + 1);
              }}
            >
              {t('chat.retry')}
            </Button>
          )}
        </div>
      )}
      {actionsContainer &&
        createPortal(
          <Button
            type="button"
            size="sm"
            className="rounded-full shadow-sm"
            disabled={!hasShapes || exporting || imageStatus !== 'ready'}
            aria-busy={exporting}
            onClick={() => void complete()}
          >
            {exporting ? <LoaderCircle className="animate-spin" /> : <Check />}
            {t('chat.drawing.complete')}
          </Button>,
          actionsContainer,
        )}
    </div>
  );
}
