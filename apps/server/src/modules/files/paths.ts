import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ThreadError } from '../threads/errors.js';

export function validatePath(path: string, allowRoot = false) {
  if (allowRoot && path === '') return path;
  if (
    !path ||
    path.length > 2048 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    [...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new ThreadError('FILE_INVALID_PATH');
  return path;
}

// API paths are workspace-relative. Symlinks are never traversed, including
// internal links, so tree, search, preview and mutations share one boundary.
export async function filePath(root: string, path: string, allowRoot = false) {
  validatePath(path, allowRoot);
  const canonical = await realpath(root);
  if (!isAbsolute(root) || canonical !== resolve(root))
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 403);
  let current = canonical;
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new ThreadError('FILE_SYMLINK', 403);
  }
  return current;
}

export function fileError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    throw new ThreadError('FILE_NOT_FOUND', 404);
  if (code === 'EEXIST' || code === 'ENOTEMPTY')
    throw new ThreadError('FILE_EXISTS', 409);
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP')
    throw new ThreadError('FILE_FORBIDDEN', 403);
  throw error;
}
