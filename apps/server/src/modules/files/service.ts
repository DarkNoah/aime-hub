import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type {
  FileListing,
  FileMutation,
  FilePreview,
} from '@aime/shared/files';
import { ThreadError } from '../threads/errors.js';
import { filePath, validatePath } from './paths.js';
import { fileMediaTypes, FILE_TEXT_LIMIT } from '@aime/shared/files';

export const TEXT_LIMIT = FILE_TEXT_LIMIT;
export const media = fileMediaTypes;
export const textVersion = (buffer: Uint8Array) =>
  createHash('sha256').update(buffer).digest('hex');

export function decodeText(buffer: Buffer, partial = false) {
  if (
    buffer.includes(0) ||
    buffer.some((byte) => (byte > 0 && byte < 9) || (byte > 13 && byte < 32))
  )
    return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer,
      {
        stream: partial,
      },
    );
  } catch {
    return null;
  }
}

export async function listFiles(
  root: string,
  path: string,
): Promise<FileListing> {
  const directory = await opendir(await filePath(root, path, true));
  const entries: FileListing['entries'] = [];
  let truncated = false;
  for await (const entry of directory) {
    if (entry.name.startsWith('._')) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    if (entries.length === 2000) {
      truncated = true;
      break;
    }
    entries.push({
      name: entry.name,
      path: path ? `${path}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
    });
  }
  entries.sort(
    (a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      a.name.localeCompare(b.name),
  );
  return { entries, truncated };
}

export async function previewFile(
  root: string,
  path: string,
): Promise<FilePreview> {
  const absolute = await filePath(root, path);
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ThreadError('FILE_NOT_FILE');
    const base = {
      path,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
    const format = media[extname(path).toLowerCase()];
    if (format) return { ...base, kind: format[0], mime: format[1] };
    const buffer = Buffer.alloc(Math.min(info.size, TEXT_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = info.size > bytesRead;
    const text = decodeText(buffer.subarray(0, bytesRead), truncated);
    return text === null
      ? { ...base, kind: 'binary', mime: 'application/octet-stream' }
      : {
          ...base,
          kind: 'text',
          mime: 'text/plain; charset=utf-8',
          text,
          truncated,
          ...(!truncated
            ? { version: textVersion(buffer.subarray(0, bytesRead)) }
            : {}),
        };
  } finally {
    await handle.close();
  }
}

// Serialize mutations across project conversations sharing a directory.
const locks = new Map<string, Promise<unknown>>();
export function withFileLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(action);
  locks.set(root, result);
  void result
    .finally(() => {
      if (locks.get(root) === result) locks.delete(root);
    })
    .catch(() => undefined);
  return result;
}

export function mutateFile(root: string, input: FileMutation) {
  return withFileLock(root, async () => {
    validatePath(input.path);
    if (input.operation === 'create') {
      const parent = dirname(input.path);
      const directory = await filePath(
        root,
        parent === '.' ? '' : parent,
        true,
      );
      const target = join(directory, basename(input.path));
      if (input.kind === 'directory') await mkdir(target);
      else await (await open(target, 'wx')).close();
      return { path: input.path };
    }
    const source = await filePath(root, input.path);
    if (input.operation === 'delete') {
      await rm(source, { recursive: true, force: false });
      return { path: input.path };
    }
    validatePath(input.name);
    if (input.name.includes('/')) throw new ThreadError('FILE_INVALID_PATH');
    const nextPath =
      input.path.slice(0, input.path.length - basename(input.path).length) +
      input.name;
    if (input.path === nextPath) return { path: nextPath };
    const destination = join(dirname(source), input.name);
    // Never knowingly replace an existing entry (including dangling symlinks).
    const existing = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      },
    );
    if (existing) throw new ThreadError('FILE_EXISTS', 409);
    await rename(source, destination);
    return { path: nextPath };
  });
}
