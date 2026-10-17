import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import type { AttachmentMetadata } from '@aime/shared/chat-attachments';
import { FILE_UPLOAD_MAX_SIZE } from '@aime/shared/files';
import {
  localWorkspaceFile,
  previewWorkspaceFile,
  streamWorkspaceFile,
} from '../files/workspace-files.js';

type Root = Parameters<typeof previewWorkspaceFile>[0];
type MediaMetadata = Pick<AttachmentMetadata, 'width' | 'height'>;

/** Read metadata from the actual media, never from a client-supplied XML attribute. */
export async function inspectAttachmentMedia(
  source: string | Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
): Promise<MediaMetadata> {
  signal?.throwIfAborted();
  if (!mimeType.startsWith('image/')) return {};
  try {
    let bytes: Uint8Array;
    if (typeof source === 'string') {
      const handle = await open(source, 'r');
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        const { bytesRead } = await handle.read(buffer);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } else bytes = source;
    const { width, height } = imageSize(bytes);
    return { width, height };
  } catch {
    signal?.throwIfAborted();
    // An unreadable image header must not hide the file reference.
    return {};
  }
}

/** Uses the same workspace path checks as file preview/download, including composite mounts. */
export class AttachmentMediaReader {
  private readonly metadata = new Map<string, MediaMetadata>();

  constructor(private readonly root: Root) {}

  async read(
    attachment: AttachmentMetadata,
    includeData: boolean,
    signal?: AbortSignal,
  ): Promise<{ attributes: AttachmentMetadata; data?: Uint8Array }> {
    signal?.throwIfAborted();
    const path = attachment.path!.replace(/^\//, '');
    const info = await previewWorkspaceFile(this.root, path);
    const attributes = { ...attachment, size: info.size };
    if (info.size > FILE_UPLOAD_MAX_SIZE) return { attributes };
    if (!includeData && !attachment.mimeType.startsWith('image/'))
      return { attributes };
    const local = await localWorkspaceFile(this.root, path);
    const key = JSON.stringify([
      path,
      info.modifiedAt,
      info.size,
      attachment.mimeType,
    ]);
    let metadata = this.metadata.get(key);
    let data: Buffer | undefined;
    let temporary: string | undefined;
    try {
      if (local) {
        metadata ??= await inspectAttachmentMedia(
          local,
          attachment.mimeType,
          signal,
        );
        if (includeData) data = await readFile(local, { signal });
      } else if (includeData || !metadata) {
        // Keep remote/composite reads bounded without buffering the whole file for metadata.
        temporary = await mkdtemp(join(tmpdir(), 'attachment-workspace-'));
        const destination = join(temporary, 'media');
        const handle = await open(destination, 'wx');
        let size = 0;
        try {
          await streamWorkspaceFile(
            this.root,
            path,
            async (chunk) => {
              signal?.throwIfAborted();
              size += chunk.length;
              if (size > info.size)
                throw new Error('Attachment changed while reading');
              await handle.writeFile(chunk);
            },
            () => !!signal?.aborted,
          );
          signal?.throwIfAborted();
          if (size !== info.size)
            throw new Error('Attachment changed while reading');
        } finally {
          await handle.close();
        }
        metadata ??= await inspectAttachmentMedia(
          destination,
          attachment.mimeType,
          signal,
        );
        if (includeData) data = await readFile(destination, { signal });
      }
      if (this.metadata.size >= 128) this.metadata.clear();
      this.metadata.set(key, metadata ?? {});
      return {
        attributes: { ...attributes, ...metadata },
        ...(data ? { data } : {}),
      };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}
