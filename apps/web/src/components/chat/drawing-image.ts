import { AssetRecordType, createShapeId, type Editor } from 'tldraw';
import type { ImageEditSource } from '@/components/image-viewer/image-edit-context';

export const drawingImageId = createShapeId('annotation-image');

/** Embed the source so exports and subsequent edits never depend on its URL. */
export async function loadDrawingImage(
  image: ImageEditSource,
  signal: AbortSignal,
) {
  const response = await fetch(image.src, {
    signal,
    referrerPolicy: image.referrerPolicy,
  });
  if (!response.ok) throw new Error('Could not load the image');
  const blob = await response.blob();
  signal.throwIfAborted();
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(signal.reason);
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(blob);
  });
  signal.throwIfAborted();
  const decoded = new Image();
  decoded.src = src;
  await decoded.decode();
  signal.throwIfAborted();
  if (!decoded.naturalWidth || !decoded.naturalHeight)
    throw new Error('Invalid image dimensions');
  return {
    src,
    width: decoded.naturalWidth,
    height: decoded.naturalHeight,
    mimeType: blob.type || 'image/png',
    name: image.name,
  };
}

export function insertDrawingImage(
  editor: Editor,
  image: Awaited<ReturnType<typeof loadDrawingImage>>,
) {
  const assetId = AssetRecordType.createId();
  editor.createAssets([
    {
      id: assetId,
      type: 'image',
      typeName: 'asset',
      props: {
        name: image.name,
        src: image.src,
        w: image.width,
        h: image.height,
        mimeType: image.mimeType,
        isAnimated: false,
      },
      meta: {},
    },
  ]);
  editor.createShape({
    id: drawingImageId,
    type: 'image',
    x: 0,
    y: 0,
    isLocked: true,
    props: { assetId, w: image.width, h: image.height },
  });
  const bounds = editor.getShapePageBounds(drawingImageId);
  if (bounds)
    editor.zoomToBounds(bounds, { inset: 64, targetZoom: 1, immediate: true });
  // Undo should remove annotations, never the underlying image.
  editor.clearHistory();
}

export function protectDrawingImage(editor: Editor) {
  const change = editor.sideEffects.registerBeforeChangeHandler(
    'shape',
    (previous, next) => (previous.id === drawingImageId ? previous : next),
  );
  const remove = editor.sideEffects.registerBeforeDeleteHandler(
    'shape',
    (shape) => (shape.id === drawingImageId ? false : undefined),
  );
  return () => {
    change();
    remove();
  };
}
