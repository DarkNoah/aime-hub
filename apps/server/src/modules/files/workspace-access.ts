import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import {
  CompositeFilesystem,
  LocalFilesystem,
  PermissionError,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';

async function canonicalPath(filename: string): Promise<string> {
  try {
    return await realpath(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const entry = await lstat(filename).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (entry?.isSymbolicLink())
      throw new Error('Cannot access a dangling workspace symlink');
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(await canonicalPath(parent), path.basename(filename));
  }
}

export async function assertLocalPath(
  filesystem: LocalFilesystem,
  filename: string,
) {
  if (!filesystem.contained) return;
  const absolute = filesystem.resolveAbsolutePath(filename);
  if (!absolute)
    throw new PermissionError(filename, 'access outside the workspace');
  // Some LocalFilesystem versions skip symlink checks under allowedPaths.
  // Check canonical targets, including parents of files that do not exist yet.
  const target = await canonicalPath(absolute);
  const roots = await Promise.all(
    [filesystem.basePath, ...filesystem.allowedPaths].map(canonicalPath),
  );
  if (
    !roots.some((root) => {
      const relative = path.relative(root, target);
      return (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    })
  )
    throw new PermissionError(filename, 'access outside the workspace');
}

/** Resolve local mounts too, including destinations that have not been created. */
export async function assertWorkspacePath(
  filesystem: WorkspaceFilesystem,
  filename: string,
): Promise<void> {
  if (filesystem instanceof LocalFilesystem)
    return assertLocalPath(filesystem, filename);
  if (filesystem instanceof CompositeFilesystem) {
    const absolute = path.posix.resolve('/', filename);
    const mount = filesystem.getMountPathForPath(absolute);
    const mounted = mount ? filesystem.mounts.get(mount) : undefined;
    if (!mount || !mounted)
      throw new PermissionError(filename, 'access outside workspace mounts');
    return assertWorkspacePath(
      mounted,
      absolute.slice(mount.length).replace(/^\/+/, '') || '.',
    );
  }
}
