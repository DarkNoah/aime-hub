import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GeneratedAsset } from '@aime/db';
import { MAX_IMAGE_BYTES, type RunInput } from '@aime/shared/threads';
import {
  serializeAttachments,
  type AttachmentMetadata,
} from '@aime/shared/chat-attachments';
import { FILE_UPLOAD_MAX_SIZE } from '@aime/shared/files';
import type { ThreadService } from '../threads/service.js';
import { ThreadError } from '../threads/errors.js';
import {
  localWorkspaceFile,
  mutateWorkspaceFile,
  previewWorkspaceFile,
  streamWorkspaceFile,
} from '../files/workspace-files.js';
import { publishUpload } from '../files/upload-workspace.js';
import { imageMimeType } from '../../mastra/providers/image-data.js';

function exists(error: unknown) {
  return (
    (error instanceof ThreadError && error.code === 'FILE_EXISTS') ||
    (error as NodeJS.ErrnoException)?.code === 'EEXIST'
  );
}

/** Large media stays in the workspace. Only bounded raster images become inline model input. */
export async function prepareAssetAttachments(
  threads: Pick<ThreadService, 'withWorkspaceFiles'>,
  userId: string,
  threadId: string,
  assets: GeneratedAsset[],
  signal?: AbortSignal,
): Promise<{ parts: RunInput['parts'] }> {
  const parts: RunInput['parts'] = [];
  const references: AttachmentMetadata[] = [];
  for (const asset of assets) {
    signal?.throwIfAborted();
    const copy =
      asset.threadId !== threadId && !asset.resourceId.startsWith('project:');
    const temporary = await mkdtemp(join(tmpdir(), 'asset-attachment-'));
    const source = join(temporary, 'source');
    let path = asset.path;
    let attachmentSize: number | undefined;
    try {
      const inline = await threads.withWorkspaceFiles(
        userId,
        asset.threadId,
        async (root) => {
          const info = await previewWorkspaceFile(root, asset.path);
          attachmentSize = info.size;
          if (info.size > FILE_UPLOAD_MAX_SIZE)
            throw new ThreadError('FILE_UPLOAD_TOO_LARGE', 413);
          const isInline =
            ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
              asset.mimeType,
            ) && info.size <= MAX_IMAGE_BYTES;
          if (!copy && !isInline) return false;
          const handle = await open(source, 'wx');
          let size = 0;
          const write = async (chunk: Uint8Array) => {
            signal?.throwIfAborted();
            size += chunk.length;
            if (size > info.size)
              throw new ThreadError('FILE_UPLOAD_TOO_LARGE', 413);
            await handle.writeFile(chunk);
          };
          try {
            const local = await localWorkspaceFile(root, asset.path);
            if (local) {
              for await (const chunk of createReadStream(local))
                await write(chunk);
            } else
              await streamWorkspaceFile(
                root,
                asset.path,
                write,
                () => !!signal?.aborted,
              );
            signal?.throwIfAborted();
            if (size !== info.size)
              throw new ThreadError('FILE_NOT_FOUND', 404);
          } finally {
            await handle.close();
          }
          return isInline;
        },
      );
      if (copy) {
        const extension = extname(asset.path)
          .replace(/[^.a-zA-Z0-9]/g, '')
          .slice(0, 16);
        path = `attachments/${asset.id}${extension}`;
        await threads.withWorkspaceFiles(userId, threadId, async (root) => {
          signal?.throwIfAborted();
          try {
            await mutateWorkspaceFile(root, {
              operation: 'create',
              path: 'attachments',
              kind: 'directory',
            });
          } catch (error) {
            if (!exists(error)) throw error;
          }
          try {
            await publishUpload(root, path, source);
          } catch (error) {
            if (!exists(error)) throw error;
            // A retry may find its existing copy; still reject replaced directories,
            // symlinks or a conflicting file instead of attaching the wrong path.
            const existing = await previewWorkspaceFile(root, path);
            if (existing.size !== (await stat(source)).size)
              throw new ThreadError('FILE_EXISTS', 409);
          }
        });
      }
      if (inline) {
        const bytes = await readFile(source);
        const header = bytes.subarray(0, 6).toString('ascii');
        const mediaType =
          header === 'GIF87a' || header === 'GIF89a'
            ? 'image/gif'
            : imageMimeType(bytes);
        parts.push({
          type: 'file',
          filename: path.split('/').at(-1),
          mediaType,
          url: `data:${mediaType};base64,${bytes.toString('base64')}`,
        });
      }
      references.push({ path, size: attachmentSize, mimeType: asset.mimeType });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  parts.push({
    type: 'text',
    text: serializeAttachments(references),
  });
  return { parts };
}
