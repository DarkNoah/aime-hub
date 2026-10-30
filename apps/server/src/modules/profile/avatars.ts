import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AVATAR_MAX_BYTES, AVATAR_SIZE } from '@aime/shared/profile';
import { withAbortSignal } from '../../lib/abort.js';

export class AvatarError extends Error {
  constructor(public code: 'AVATAR_INVALID' | 'AVATAR_TOO_LARGE') {
    super(code);
  }
}

export class AvatarService {
  readonly directory: string;

  constructor(workspaceRoot: string) {
    this.directory = join(workspaceRoot, '.resources', 'avatars');
  }

  async upload(input: Buffer, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (input.length > AVATAR_MAX_BYTES)
      throw new AvatarError('AVATAR_TOO_LARGE');
    const image = sharp(input, { limitInputPixels: 40_000_000, pages: 1 });
    let output: Buffer;
    try {
      const metadata = await withAbortSignal(signal, () => image.metadata());
      if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? ''))
        throw new AvatarError('AVATAR_INVALID');
      signal?.throwIfAborted();
      // Re-encode raster pixels, strip metadata, and enforce square output even
      // when callers bypass the browser cropper.
      output = await withAbortSignal(signal, () =>
        image
          .autoOrient()
          .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
          .webp({ quality: 82 })
          .timeout({ seconds: 15 })
          .toBuffer(),
      );
    } catch {
      signal?.throwIfAborted();
      throw new AvatarError('AVATAR_INVALID');
    } finally {
      image.destroy();
    }
    signal?.throwIfAborted();
    const filename = `${createHash('sha256').update(output).digest('hex')}.webp`;
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `.upload-${randomUUID()}`);
    try {
      await writeFile(temporary, output, { flag: 'wx', signal });
      signal?.throwIfAborted();
      // Publish complete files atomically. Identical content shares one URL;
      // changing pixels always creates a new immutable resource.
      await link(temporary, join(this.directory, filename)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return `/api/resources/avatars/${filename}`;
  }

  async read(filename: string) {
    if (!/^[a-f0-9]{64}\.webp$/.test(filename)) return null;
    try {
      const file = await open(
        join(this.directory, filename),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return null;
        return {
          data: await file.readFile(),
          modified: stat.mtime.toUTCString(),
          etag: `"${filename.slice(0, -5)}"`,
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        ['ENOENT', 'ELOOP', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return null;
      throw error;
    }
  }
}
