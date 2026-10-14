import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, posix } from 'node:path';
import {
  CompositeFilesystem,
  LocalFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import type { FileScope, WorkspaceFileReference } from '@aime/shared/files';
import { ThreadError } from '../threads/errors.js';
import { filePath } from './paths.js';
import { resolveWorkspaceTarget } from './workspace-files.js';

export function validateFileReference(path: string) {
  if (
    !path ||
    path.length > 2048 ||
    path.includes('\\') ||
    [...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.startsWith('//') ||
    path.split('/').some((part) => part.includes(':'))
  )
    throw new ThreadError('FILE_INVALID_PATH');
}

function within(root: string, absolute: string): string | undefined {
  const path = relative(root, absolute);
  return path === '..' || path.startsWith('../') || isAbsolute(path)
    ? undefined
    : path;
}

function mountedPath(
  root: string | WorkspaceFilesystem,
  absolute: string,
): string | undefined {
  if (typeof root === 'string') return within(root, absolute);
  if (root instanceof LocalFilesystem) return within(root.basePath, absolute);
  if (root instanceof CompositeFilesystem) {
    for (const mount of root.mountPaths) {
      const filesystem = root.getFilesystemForPath(mount);
      if (!filesystem) continue;
      const path = mountedPath(filesystem, absolute);
      if (path !== undefined) return posix.join(mount, path).replace(/^\//, '');
    }
  }
  return undefined;
}

/** Map links to the existing file-manager roots; never read outside those roots. */
export async function resolveFileReference(
  root: string | WorkspaceFilesystem,
  reference: string,
  workingDirectory: string,
  scope: FileScope,
): Promise<WorkspaceFileReference | undefined> {
  validateFileReference(reference);
  const absolute = resolve(workingDirectory, reference);
  let path = mountedPath(root, absolute);
  if (
    path === undefined &&
    typeof root !== 'string' &&
    !(root instanceof LocalFilesystem) &&
    scope === 'thread'
  ) {
    // Provider paths are virtual paths relative to the project workspace.
    path = within(workingDirectory, absolute);
    if (
      path === undefined &&
      reference.startsWith('/') &&
      root instanceof CompositeFilesystem &&
      root.getMountPathForPath(reference)
    )
      path = posix.normalize(reference).replace(/^\//, '');
  }
  if (path === undefined) return undefined;
  const leaf = resolveWorkspaceTarget(root, path, true);
  const info =
    typeof leaf.root === 'string'
      ? await stat(await filePath(leaf.root, leaf.path, true))
      : await leaf.root.stat(leaf.path || '/');
  const kind =
    'isDirectory' in info
      ? info.isDirectory()
        ? 'directory'
        : info.isFile()
          ? 'file'
          : undefined
      : info.type;
  if (kind !== 'file' && kind !== 'directory')
    throw new ThreadError('FILE_FORBIDDEN', 403);
  return { scope, path, kind };
}
