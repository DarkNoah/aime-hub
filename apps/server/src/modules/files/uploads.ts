import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILE_UPLOAD_CHUNK_SIZE,
  type FileUploadInput,
  type FileUploadSession,
} from '@aime/shared/files';
import { ThreadError } from '../threads/errors.js';

type Owner = { userId: string; threadId: string };
type Upload = Owner &
  FileUploadInput & {
    directory: string;
    offset: number;
    complete: boolean;
    pending: Promise<unknown>;
    timer?: ReturnType<typeof setTimeout>;
  };
const TTL = 30 * 60 * 1000;

/** Private staging files; each session belongs to a user and the initiating thread. */
export class FileUploads {
  private sessions = new Map<string, Upload>();

  async create(
    owner: Owner,
    input: FileUploadInput,
  ): Promise<FileUploadSession> {
    if (
      this.sessions.size >= 64 ||
      [...this.sessions.values()].filter(
        (session) => session.userId === owner.userId && !session.complete,
      ).length >= 8
    )
      throw new ThreadError('FILE_UPLOAD_LIMIT', 429);
    const id = randomUUID();
    const session: Upload = {
      ...owner,
      ...input,
      directory: '',
      offset: 0,
      complete: false,
      pending: Promise.resolve(),
    };
    // Reserve before asynchronous IO so concurrent requests cannot bypass the limit.
    this.sessions.set(id, session);
    try {
      session.directory = await mkdtemp(join(tmpdir(), 'workspace-upload-'));
      await (await open(join(session.directory, 'data'), 'wx', 0o600)).close();
      this.touch(id, session);
      return { id, chunkSize: FILE_UPLOAD_CHUNK_SIZE, offset: 0 };
    } catch (error) {
      this.sessions.delete(id);
      if (session.directory)
        await rm(session.directory, { recursive: true, force: true });
      throw error;
    }
  }

  private touch(id: string, session: Upload) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      void this.cancel(session, id).catch(() => undefined);
    }, TTL);
    session.timer.unref();
  }

  private async run<T>(
    owner: Owner,
    id: string,
    action: (session: Upload) => Promise<T>,
  ) {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.userId !== owner.userId ||
      session.threadId !== owner.threadId
    )
      throw new ThreadError('FILE_UPLOAD_EXPIRED', 404);
    const pending = session.pending
      .catch(() => undefined)
      .then(() => {
        if (this.sessions.get(id) !== session)
          throw new ThreadError('FILE_UPLOAD_EXPIRED', 404);
        this.touch(id, session);
        return action(session);
      });
    session.pending = pending;
    return pending;
  }

  chunk(owner: Owner, id: string, offset: number, data: Uint8Array) {
    return this.run(owner, id, async (session) => {
      if (
        session.complete ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !data.length ||
        data.length > FILE_UPLOAD_CHUNK_SIZE ||
        offset + data.length > session.size ||
        offset > session.offset
      )
        throw new ThreadError('FILE_UPLOAD_CHUNK', 400);
      const handle = await open(join(session.directory, 'data'), 'r+');
      try {
        if (offset < session.offset) {
          // A lost response may lead to a duplicate PUT. Only identical bytes are idempotent.
          const previous = Buffer.alloc(data.length);
          const { bytesRead } = await handle.read(
            previous,
            0,
            previous.length,
            offset,
          );
          if (
            offset + data.length > session.offset ||
            bytesRead !== data.length ||
            !previous.equals(Buffer.from(data))
          )
            throw new ThreadError('FILE_UPLOAD_CHUNK', 409);
        } else {
          let written = 0;
          while (written < data.length) {
            const { bytesWritten } = await handle.write(
              data,
              written,
              data.length - written,
              offset + written,
            );
            if (!bytesWritten) throw new Error('Upload write made no progress');
            written += bytesWritten;
          }
          session.offset += data.length;
        }
        return { offset: session.offset };
      } finally {
        await handle.close();
      }
    });
  }

  complete(
    owner: Owner,
    id: string,
    publish: (input: FileUploadInput, source: string) => Promise<unknown>,
  ) {
    return this.run(owner, id, async (session) => {
      if (session.complete) return { path: session.path };
      if (session.offset !== session.size)
        throw new ThreadError('FILE_UPLOAD_INCOMPLETE', 409);
      await publish(session, join(session.directory, 'data'));
      session.complete = true;
      await rm(session.directory, { recursive: true, force: true });
      return { path: session.path };
    });
  }

  cancel(
    owner: Owner,
    id: string,
    discard?: (input: FileUploadInput) => Promise<unknown>,
  ) {
    return this.run(owner, id, async (session) => {
      // Serialize with completion so cancellation also removes a file that
      // finished publishing while the client was aborting the request.
      if (session.complete && discard) await discard(session);
      await rm(session.directory, { recursive: true, force: true });
      clearTimeout(session.timer);
      this.sessions.delete(id);
      return { cancelled: true };
    });
  }
}
