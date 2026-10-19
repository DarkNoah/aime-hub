import { basename, extname, posix } from 'node:path';
import {
  LocalFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
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

function checkSize(size: number) {
  if (!size) throw new ThreadError('FILE_EMPTY');
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBinaryFileBytes)
    throw new ThreadError('FILE_TOO_LARGE', 413);
}

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

/** Use the same filesystem permissions as the native read tool. */
export async function readBinaryWorkspaceFile(
  filesystem: WorkspaceFilesystem,
  reference: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  // Uploaded links use a workspace-root prefix even on local filesystems.
  const inputPath = reference.replace(/^\/(?=\.uploads\/)/, '');
  if (!inputPath || inputPath.includes('\0'))
    throw new ThreadError('FILE_INVALID_PATH');
  const before = await filesystem.stat(inputPath);
  if (before.type !== 'file') throw new ThreadError('FILE_NOT_FILE');
  const path =
    filesystem instanceof LocalFilesystem
      ? before.path
      : posix.normalize(inputPath).replace(/^\//, '');
  const extension = extname(path).toLowerCase();
  if (
    ![
      '.pdf',
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
      '.bmp',
      '.tif',
      '.tiff',
      '.jp2',
    ].includes(extension)
  )
    throw new ThreadError('FILE_TYPE_UNSUPPORTED');
  checkSize(before.size);
  signal.throwIfAborted();
  // Let the provider enforce contained/allowedPaths and resolve symlinks/mounts.
  // File-manager roots deliberately have a narrower scope than Agent reads.
  const contents = await filesystem.readFile(inputPath);
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  checkSize(data.length);
  signal.throwIfAborted();
  const after = await filesystem.stat(inputPath);
  if (
    data.length !== before.size ||
    after.size !== before.size ||
    after.modifiedAt.getTime() !== before.modifiedAt.getTime()
  )
    throw new ThreadError('FILE_CHANGED');
  signal.throwIfAborted();
  if (extension === '.pdf') {
    if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new ThreadError('FILE_INVALID_FORMAT');
    return {
      path,
      fileName: basename(path),
      size: data.length,
      mimeType: 'application/pdf',
      kind: 'pdf' as const,
      width: undefined,
      height: undefined,
      data,
    };
  }
  return {
    ...inspectImageFile(data, path),
    path,
    size: data.length,
    data,
  };
}
