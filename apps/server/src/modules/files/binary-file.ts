import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  LocalFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import { imageSize } from 'image-size';
import { ThreadError } from '../threads/errors.js';
import { resolveFileReference } from './reference.js';
import { filePath } from './paths.js';
import {
  resolveWorkspaceTarget,
  streamWorkspaceFile,
} from './workspace-files.js';

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

/** Bounded reads through the same roots and symlink checks as the file manager. */
export async function readBinaryWorkspaceFile(
  filesystem: WorkspaceFilesystem,
  reference: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const source = await resolveFileReference(
    filesystem,
    reference.replace(/^\/(?=\.uploads\/)/, ''),
    filesystem instanceof LocalFilesystem ? filesystem.basePath : '/',
    'thread',
  );
  if (!source) throw new ThreadError('FILE_FORBIDDEN', 403);
  if (source.kind !== 'file') throw new ThreadError('FILE_NOT_FILE');
  const path = source.path;
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
  const leaf = resolveWorkspaceTarget(filesystem, path);
  let data: Buffer;
  if (typeof leaf.root === 'string') {
    const handle = await open(
      await filePath(leaf.root, leaf.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new ThreadError('FILE_NOT_FILE');
      checkSize(before.size);
      data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(
          data,
          offset,
          Math.min(64 * 1024, data.length - offset),
          offset,
        );
        if (!bytesRead) throw new ThreadError('FILE_CHANGED');
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw new ThreadError('FILE_CHANGED');
    } finally {
      await handle.close();
    }
  } else {
    const before = await leaf.root.stat(leaf.path);
    checkSize(before.size);
    const chunks: Uint8Array[] = [];
    let size = 0;
    await streamWorkspaceFile(
      filesystem,
      path,
      async (chunk) => {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > before.size) throw new ThreadError('FILE_CHANGED');
        chunks.push(chunk);
      },
      () => signal.aborted,
      0,
      before.size,
    );
    signal.throwIfAborted();
    const after = await leaf.root.stat(leaf.path);
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.modifiedAt.getTime() !== before.modifiedAt.getTime()
    )
      throw new ThreadError('FILE_CHANGED');
    data = Buffer.concat(chunks);
  }
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
      data,
    };
  }
  try {
    const image = imageSize(data);
    const format = imageFormats[image.type ?? ''];
    if (!format) throw new Error('Unsupported image');
    return {
      path,
      fileName: `${basename(path, extname(path))}${format[1]}`,
      size: data.length,
      mimeType: format[0],
      kind: 'image' as const,
      width: image.width,
      height: image.height,
      data,
    };
  } catch {
    throw new ThreadError('FILE_INVALID_FORMAT');
  }
}
