import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  Tldraw,
  getSnapshot,
  useValue,
  type Editor,
  type TLComponents,
} from 'tldraw';
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite';
import 'tldraw/tldraw.css';
import './drawing-canvas.css';
import { MAX_IMAGE_BYTES } from '@aime/shared/threads';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/theme/context';
import type { DrawingDialogProps } from './drawing-dialog';

// Bundle fonts, translations and icons with the app, including offline deployments.
const assetUrls = getAssetUrlsByImport();
const components: TLComponents = { MainMenu: null, PageMenu: null };

export function DrawingCanvas({
  onComplete,
  initialSnapshot,
}: Pick<DrawingDialogProps, 'onComplete' | 'initialSnapshot'>) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [editor, setEditor] = useState<Editor>();
  const [exporting, setExporting] = useState(false);
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
    editor?.user.updateUserPreferences({
      colorScheme: resolvedTheme,
      locale: i18n.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
    });
  }, [editor, resolvedTheme, i18n.language]);

  async function complete() {
    if (!editor || active.current) return;
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
      const bounds = editor.getShapePageBounds(ids[0])?.clone();
      for (const id of ids.slice(1)) {
        const next = editor.getShapePageBounds(id);
        if (next) bounds?.union(next);
      }
      let scale = Math.min(
        2,
        4096 / Math.max(1, (bounds?.w ?? 1) + 64, (bounds?.h ?? 1) + 64),
      );
      for (let attempt = 0; attempt < 6; attempt++) {
        const { blob } = await editor.toImage(ids, {
          format: 'png',
          background: true,
          darkMode: false,
          pixelRatio: 1,
          scale,
        });
        controller.signal.throwIfAborted();
        if (blob.size > 0 && blob.size <= MAX_IMAGE_BYTES) {
          onComplete(
            new File([blob], `drawing-${Date.now()}.png`, {
              type: 'image/png',
            }),
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
      <Button
        type="button"
        className="absolute right-3 bottom-16 z-10 rounded-full shadow-sm"
        disabled={!hasShapes || exporting}
        onClick={() => void complete()}
      >
        {exporting ? <LoaderCircle className="animate-spin" /> : <Check />}
        {t(exporting ? 'chat.drawing.exporting' : 'chat.drawing.complete')}
      </Button>
    </div>
  );
}
