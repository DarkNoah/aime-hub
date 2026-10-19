import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CompositeFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import type { FilePreview, FileSave } from '@aime/shared/files';
import { ThreadError } from '../threads/errors.js';
import { filePath } from './paths.js';
import {
  decodeText,
  previewFile,
  TEXT_LIMIT,
  textVersion,
  withFileLock,
} from './service.js';
import {
  previewWorkspaceFile,
  resolveWorkspaceTarget,
  withWorkspaceFileLock,
} from './workspace-files.js';

function checkVersion(current: FilePreview, version: string) {
  if (current.kind !== 'text' || current.truncated || !current.version)
    throw new ThreadError('FILE_NOT_EDITABLE');
  if (current.version !== version) throw new ThreadError('FILE_CHANGED', 409);
}

export async function saveWorkspaceFile(
  root: string | WorkspaceFilesystem,
  input: FileSave,
): Promise<FilePreview> {
  const buffer = Buffer.from(input.text, 'utf8');
  if (buffer.length > TEXT_LIMIT)
    throw new ThreadError('FILE_TEXT_TOO_LARGE', 413);
  if (decodeText(buffer) !== input.text)
    throw new ThreadError('FILE_NOT_EDITABLE');
  const leaf = resolveWorkspaceTarget(root, input.path);
  if (!leaf.path || leaf.root instanceof CompositeFilesystem)
    throw new ThreadError('FILE_FORBIDDEN', 403);
  const filesystem = leaf.root;
  if (typeof filesystem === 'string') {
    return withFileLock(filesystem, async () => {
      checkVersion(await previewFile(filesystem, leaf.path), input.version);
      const absolute = await filePath(filesystem, leaf.path);
      const original = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await original.stat().finally(() => original.close());
      if (!info.isFile()) throw new ThreadError('FILE_NOT_FILE');
      // Write a sibling first so an interrupted write never truncates the original.
      const temporary = join(dirname(absolute), `.file-edit-${randomUUID()}`);
      const handle = await open(temporary, 'wx', info.mode & 0o777);
      try {
        await handle.writeFile(buffer);
        await handle.chmod(info.mode & 0o777);
        await handle.sync();
        const saved = await handle.stat();
        checkVersion(await previewFile(filesystem, leaf.path), input.version);
        await filePath(filesystem, leaf.path);
        await rename(temporary, absolute);
        return {
          path: input.path,
          kind: 'text',
          mime: 'text/plain; charset=utf-8',
          text: input.text,
          size: buffer.length,
          modifiedAt: saved.mtime.toISOString(),
          truncated: false,
          version: textVersion(buffer),
        };
      } finally {
        await handle.close();
        await rm(temporary, { force: true });
      }
    });
  }
  return withWorkspaceFileLock(filesystem, async () => {
    checkVersion(
      await previewWorkspaceFile(filesystem, leaf.path),
      input.version,
    );
    await filesystem.writeFile(leaf.path, buffer, {
      overwrite: true,
      recursive: false,
    });
    const info = await filesystem.stat(leaf.path);
    return {
      path: input.path,
      kind: 'text',
      mime: 'text/plain; charset=utf-8',
      text: input.text,
      size: buffer.length,
      modifiedAt: info.modifiedAt.toISOString(),
      truncated: false,
      version: textVersion(buffer),
    };
  });
}
