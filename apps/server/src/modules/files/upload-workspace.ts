import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, lstat, rm } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { constants } from 'node:fs';
import { AgentFSFilesystem } from '@mastra/agentfs';
import {
  CompositeFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import { ThreadError } from '../threads/errors.js';
import { filePath } from './paths.js';
import {
  resolveWorkspaceTarget,
  withWorkspaceFileLock,
} from './workspace-files.js';

type Root = string | WorkspaceFilesystem;

// Resolve mounts and validate again at completion: a directory may have changed
// while the browser was sending chunks.
export async function uploadDestination(root: Root, path: string) {
  const leaf = resolveWorkspaceTarget(root, path);
  if (!leaf.path || leaf.root instanceof CompositeFilesystem)
    throw new ThreadError('FILE_FORBIDDEN', 403);
  if (basename(leaf.path).length > 255)
    throw new ThreadError('FILE_INVALID_PATH');
  const parent = posix.dirname(leaf.path);
  if (typeof leaf.root === 'string') {
    const directory = await filePath(
      leaf.root,
      parent === '.' ? '' : parent,
      true,
    );
    if (!(await lstat(directory)).isDirectory())
      throw new ThreadError('FILE_NOT_FOUND', 404);
    const destination = join(directory, basename(leaf.path));
    const existing = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      },
    );
    if (existing) throw new ThreadError('FILE_EXISTS', 409);
    return { root: leaf.root, path: destination };
  }
  if (!(leaf.root instanceof AgentFSFilesystem) || !leaf.root.agent)
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 404);
  if (leaf.root.readOnly) throw new ThreadError('FILE_FORBIDDEN', 403);
  let directory = '/';
  for (const part of parent === '.' ? [] : parent.split('/')) {
    const entry = (await leaf.root.readdir(directory)).find(
      (entry) => entry.name === part,
    );
    if (entry?.isSymlink) throw new ThreadError('FILE_SYMLINK', 403);
    if (entry?.type !== 'directory')
      throw new ThreadError('FILE_NOT_FOUND', 404);
    directory = posix.join(directory, part);
  }
  if (await leaf.root.exists(leaf.path))
    throw new ThreadError('FILE_EXISTS', 409);
  return { root: leaf.root, path: leaf.path };
}

export async function publishUpload(root: Root, path: string, source: string) {
  const leaf = await uploadDestination(root, path);
  if (typeof leaf.root === 'string') {
    const temporary = join(dirname(leaf.path), `.upload-${randomUUID()}`);
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      // Atomic publication without replacing a file created during the upload.
      await uploadDestination(root, path);
      await link(temporary, leaf.path);
    } finally {
      await rm(temporary, { force: true });
    }
  } else {
    const filesystem = leaf.root;
    await withWorkspaceFileLock(filesystem, async () => {
      await uploadDestination(root, path);
      const temporary = posix.join(
        posix.dirname(leaf.path),
        `.upload-${randomUUID()}`,
      );
      await filesystem.writeFile(temporary, '', {
        overwrite: false,
        recursive: false,
      });
      try {
        const handle = await filesystem.agent!.fs.open(temporary);
        let offset = 0;
        // AgentFS appendFile reads the whole file; positional writes keep memory bounded.
        for await (const chunk of createReadStream(source, {
          highWaterMark: 256 * 1024,
        })) {
          await handle.pwrite(offset, chunk as Buffer);
          offset += chunk.length;
        }
        await uploadDestination(root, path);
        await filesystem.moveFile(temporary, leaf.path, { overwrite: false });
      } finally {
        await filesystem.deleteFile(temporary, { force: true });
      }
    });
  }
  return { path };
}
