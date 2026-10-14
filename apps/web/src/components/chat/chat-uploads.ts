import { nanoid } from 'nanoid';
import {
  MAX_CHAT_FILES,
  MAX_IMAGE_BYTES,
  type RunInput,
} from '@aime/shared/threads';
import { FILE_UPLOAD_MAX_SIZE } from '@aime/shared/files';
import type { UploadOptions } from '../file-manager/upload.js';

export type ChatUpload = {
  id: string;
  file: File;
  preview: string;
  status: 'queued' | 'uploading' | 'finishing' | 'done' | 'error';
  progress: number;
  path?: string;
  image?: Extract<RunInput['parts'][number], { type: 'file' }>;
  error?: unknown;
};
type Entry = ChatUpload & {
  controller: AbortController;
  threadId?: string;
  directory: string;
};
export type ChatUploadDependencies = {
  ensureThread: () => Promise<string>;
  prepare: (threadId: string, directory: string) => Promise<void>;
  upload: (
    threadId: string,
    directory: string,
    file: File,
    options: UploadOptions,
  ) => Promise<{ path: string }>;
  remove: (threadId: string, directory: string) => Promise<unknown>;
  image: (file: File) => Promise<string>;
  onError: (error: unknown, file: File) => void;
  onUploaded: (file: File) => void;
};

export function isInlineChatImage(file: File) {
  return (
    file.size > 0 &&
    file.size <= MAX_IMAGE_BYTES &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
  );
}

export function chatUploadParts(
  items: readonly ChatUpload[],
): RunInput['parts'] {
  if (items.some((item) => item.status !== 'done' || !item.path))
    throw new Error('Uploads are not ready');
  const parts: RunInput['parts'] = items.flatMap((item) =>
    item.image ? [item.image] : [],
  );
  if (items.length)
    parts.push({
      type: 'text',
      text: `Uploaded files (workspace paths):\n${items.map((item) => `- ${JSON.stringify(`/${item.path}`)}`).join('\n')}`,
    });
  return parts;
}

/** Bounded queue shared by file selection, paste and drop. Raw large files stay as blobs. */
export class ChatUploadQueue {
  private entries: Entry[] = [];
  private active = new Set<Entry>();
  private listeners = new Set<() => void>();
  private snapshot: ChatUpload[] = [];
  private disposed = false;
  constructor(private deps: ChatUploadDependencies) {}
  configure(
    callbacks: Pick<
      ChatUploadDependencies,
      'ensureThread' | 'onError' | 'onUploaded'
    >,
  ) {
    Object.assign(this.deps, callbacks);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot = this.entries.map((entry) => ({ ...entry }));
    this.listeners.forEach((listener) => listener());
  }
  add(files: File[] | FileList, reserved = 0) {
    if (this.disposed) return;
    for (const file of Array.from(files)) {
      const code =
        file.size > FILE_UPLOAD_MAX_SIZE
          ? 'FILE_UPLOAD_TOO_LARGE'
          : this.entries.length + reserved >= MAX_CHAT_FILES
            ? 'CHAT_ATTACHMENT_LIMIT'
            : null;
      if (code) {
        this.deps.onError({ code }, file);
        continue;
      }
      const id = nanoid();
      this.entries.push({
        id,
        file,
        preview: isInlineChatImage(file) ? URL.createObjectURL(file) : '',
        directory: `.uploads/${id}`,
        controller: new AbortController(),
        status: 'queued',
        progress: 0,
      });
    }
    this.emit();
    this.pump();
  }
  private pump() {
    if (this.disposed) return;
    for (const entry of this.entries) {
      if (this.active.size >= 2) break;
      if (entry.status !== 'queued' || this.active.has(entry)) continue;
      this.active.add(entry);
      entry.status = 'uploading';
      this.emit();
      void this.run(entry).finally(() => {
        this.active.delete(entry);
        this.pump();
      });
    }
  }
  private async clean(entry: Entry) {
    if (entry.threadId) await this.deps.remove(entry.threadId, entry.directory);
  }
  private async run(entry: Entry) {
    const { signal } = entry.controller;
    try {
      entry.threadId = await this.deps.ensureThread();
      signal.throwIfAborted();
      if (isInlineChatImage(entry.file))
        entry.image = {
          type: 'file',
          filename: entry.file.name,
          mediaType: entry.file.type as NonNullable<
            ChatUpload['image']
          >['mediaType'],
          url: await this.deps.image(entry.file),
        };
      signal.throwIfAborted();
      await this.deps.prepare(entry.threadId, entry.directory);
      signal.throwIfAborted();
      const result = await this.deps.upload(
        entry.threadId,
        entry.directory,
        entry.file,
        {
          signal,
          onProgress: (progress) => {
            entry.progress = progress;
            this.emit();
          },
          onFinishing: () => {
            entry.status = 'finishing';
            this.emit();
          },
        },
      );
      signal.throwIfAborted();
      entry.path = result.path;
      entry.status = 'done';
      this.emit();
      this.deps.onUploaded(entry.file);
    } catch (error) {
      try {
        await this.clean(entry);
      } catch (cleanupError) {
        this.deps.onError(cleanupError, entry.file);
      }
      if (!signal.aborted) {
        entry.status = 'error';
        entry.error = error;
        this.emit();
        this.deps.onError(error, entry.file);
      }
    }
  }
  cancel(id: string) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    this.entries = this.entries.filter((item) => item !== entry);
    entry.controller.abort();
    if (entry.preview) URL.revokeObjectURL(entry.preview);
    this.emit();
    if (!this.active.has(entry))
      void this.clean(entry).catch((error) =>
        this.deps.onError(error, entry.file),
      );
    this.pump();
  }
  retry(id: string) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry || entry.status !== 'error' || this.active.has(entry)) return;
    entry.controller = new AbortController();
    entry.directory = `.uploads/${nanoid()}`;
    entry.status = 'queued';
    entry.progress = 0;
    entry.error = undefined;
    this.emit();
    this.pump();
  }
  /** Sent files belong to the message; release previews without deleting them. */
  commit() {
    for (const entry of this.entries)
      if (entry.preview) URL.revokeObjectURL(entry.preview);
    this.entries = [];
    this.emit();
  }
  dispose() {
    this.disposed = true;
    // Completed files may already belong to a send accepted during navigation.
    // Explicit removal deletes them; unmount only cancels unfinished uploads.
    for (const entry of [...this.entries]) {
      if (entry.status !== 'done') this.cancel(entry.id);
      else if (entry.preview) URL.revokeObjectURL(entry.preview);
    }
  }
  resume() {
    this.disposed = false;
    this.pump();
  }
}
