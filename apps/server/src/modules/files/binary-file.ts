import { basename, extname } from 'node:path';
import { imageSize } from 'image-size';
import { ThreadError } from '../threads/errors.js';

export const maxBinaryFileBytes = 200 * 1024 * 1024;
const imageFormats: Record<string, [string, string]> = {
  png: ['image/png', '.png'],
  jpg: ['image/jpeg', '.jpg'],
  gif: ['image/gif', '.gif'],
  webp: ['image/webp', '.webp'],
  bmp: ['image/bmp', '.bmp'],
  tiff: ['image/tiff', '.tiff'],
  jp2: ['image/jp2', '.jp2'],
};

export function inspectImageFile(data: Uint8Array, fileName: string) {
  try {
    const image = imageSize(data);
    const format = imageFormats[image.type ?? ''];
    if (!format) throw new Error('Unsupported image');
    return {
      fileName: `${basename(fileName, extname(fileName))}${format[1]}`,
      mimeType: format[0],
      kind: 'image' as const,
      width: image.width,
      height: image.height,
    };
  } catch {
    throw new ThreadError('FILE_INVALID_FORMAT');
  }
}
