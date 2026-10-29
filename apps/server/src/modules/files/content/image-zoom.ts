import { basename, extname } from 'node:path';
import sharp from 'sharp';
import { withAbortSignal } from '../../../lib/abort.js';
import { inspectImageFile } from '../binary-file.js';
import { FileContentError } from './types.js';

/** Crop in the original pixel grid, then resize; source bytes are never overwritten. */
export async function zoomImage(
  data: Buffer,
  fileName: string,
  value: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const invalid = (message: string) =>
    new FileContentError('INVALID_FILE_PARAMETERS', `image_zoom: ${message}`);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('应为 { x, y, w, h, scale? }。');
  const { x, y, w, h, scale = 2 } = value as Record<string, unknown>;
  if (
    typeof x !== 'number' ||
    !Number.isSafeInteger(x) ||
    x < 0 ||
    typeof y !== 'number' ||
    !Number.isSafeInteger(y) ||
    y < 0 ||
    typeof w !== 'number' ||
    !Number.isSafeInteger(w) ||
    w <= 0 ||
    typeof h !== 'number' ||
    !Number.isSafeInteger(h) ||
    h <= 0 ||
    typeof scale !== 'number' ||
    !Number.isFinite(scale) ||
    scale <= 0
  )
    throw invalid(
      'x/y 应为非负整数，w/h 应为正整数，scale 应为正数（默认 2）。',
    );
  const source = inspectImageFile(data, fileName);
  if (
    ![
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/tiff',
    ].includes(source.mimeType)
  )
    throw new FileContentError(
      'IMAGE_ZOOM_UNSUPPORTED',
      '区域放大支持 PNG、JPEG、WebP、GIF 和 TIFF；BMP、JP2 请先转换为 PNG/JPEG。',
    );
  if (x + w > source.width || y + h > source.height)
    throw invalid(`区域超出原图范围 ${source.width}×${source.height}。`);
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 16_000_000 ||
    source.width * source.height > 40_000_000
  )
    throw invalid(
      '原图最多 4000 万像素，缩放结果需为 1 到 1600 万像素。请缩小区域或调整 scale。',
    );
  let image: ReturnType<typeof sharp> | undefined;
  try {
    image = sharp(data, {
      limitInputPixels: 40_000_000,
      autoOrient: false,
      pages: 1,
    })
      .extract({ left: x, top: y, width: w, height: h })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      .png()
      .timeout({ seconds: 30 });
    // Return immediately on abort, even while libvips is finishing native work.
    const png = await withAbortSignal(signal, () => image!.toBuffer());
    signal.throwIfAborted();
    return {
      data: png,
      ...inspectImageFile(
        png,
        `${basename(fileName, extname(fileName))}-zoom.png`,
      ),
      size: png.length,
    };
  } catch {
    signal.throwIfAborted();
    throw new FileContentError(
      'IMAGE_ZOOM_FAILED',
      '图片区域处理失败，请检查图片内容，或缩小区域和放大倍数后重试。',
    );
  } finally {
    image?.destroy();
  }
}
