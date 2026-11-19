import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NetworkRecordCodec,
  NetworkRecordIntegrityError,
  legacyRecordName,
  parseNetworkRecordName,
  type NetworkRecordFile,
} from './network-record-file.js';

export const networkRetentionMs = 15 * 60_000;
const maxPerScope = 512;
const maxRecords = 2048;
export type NetworkCaptureScope = {
  userId: string;
  threadId: string;
  projectId?: string;
};

type Payload = {
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  requestBodyOmitted?: string;
  responseBodyOmitted?: string;
};

export type NetworkRequestInput = Payload & {
  startedAt?: number;
  url: string;
  method: string;
  resourceType: string;
  redirectedFrom?: string;
};

export type NetworkRequestPatch = Payload & {
  state?: 'pending' | 'finished' | 'failed';
  status?: number;
  durationMs?: number;
  error?: string;
  mimeType?: string;
};

export type NetworkRequestHandle = {
  readonly id: string;
  readonly captureId: string;
};

export type NetworkRequestSummary = NetworkRequestHandle & {
  startedAt: string;
  url: string;
  method: string;
  resourceType: string;
  state: NonNullable<NetworkRequestPatch['state']>;
  status?: number;
  durationMs?: number;
  redirectedFrom?: string;
};

export type NetworkRequestDetail = NetworkRequestSummary & NetworkRequestPatch;
export type NetworkListFilters = {
  url?: string;
  method?: string;
  status?: number;
  limit?: number;
  offset?: number;
};

type Entry = NetworkRecordFile & {
  writes: Promise<void>;
  timer: NodeJS.Timeout;
  published: boolean;
};

function scopeKey(scope: NetworkCaptureScope) {
  return JSON.stringify([
    scope.userId,
    scope.projectId ?? null,
    scope.threadId,
  ]);
}

function notFound() {
  return new Error('Network request not found or expired');
}

function logCleanupFailure() {
  console.warn('Could not clean temporary browser network records');
}

/** The disk index survives restarts. Only the originating recorder can append to an in-flight request. */
export class NetworkCaptureStore {
  private readonly directory: string;
  private readonly codec: NetworkRecordCodec;
  private readonly handles = new WeakMap<NetworkRequestHandle, Entry>();
  private readonly deleting = new Set<string>();
  private readonly now: () => number;
  private readonly active = new Map<
    string,
    {
      id: string;
      ticket: number;
      startedAt: number;
      scope: NetworkCaptureScope;
      ready: Promise<void>;
    }
  >();
  private readonly entries = new Map<string, Entry>();
  private readonly removals = new Set<Promise<void>>();
  private ticket = 0;
  private disposed = false;
  private readonly sweepTimer: NodeJS.Timeout;
  private sweeping?: Promise<void>;

  constructor(
    options: { directory?: string; now?: () => number; secret?: string } = {},
  ) {
    this.codec = new NetworkRecordCodec(options.secret);
    this.directory =
      options.directory ??
      join(tmpdir(), 'chat-browser-network-' + (process.getuid?.() ?? 'user'));
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(() => {
      void this.cleanup().catch(logCleanupFailure);
    }, 30_000);
    this.sweepTimer.unref();
    void this.cleanup().catch(logCleanupFailure);
  }

  private async checkDirectory() {
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      (process.getuid &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    ) {
      throw new Error(
        'A private browser network temporary directory is required',
      );
    }
  }

  private remember(file: NetworkRecordFile, published: boolean): Entry {
    const timer = setTimeout(
      () => this.discard(entry),
      Math.max(1, file.startedAt + networkRetentionMs - this.now()),
    );
    timer.unref();
    const entry = { ...file, timer, published, writes: Promise.resolve() };
    this.entries.set(file.name, entry);
    return entry;
  }

  private trim() {
    if (this.entries.size <= maxPerScope) return;
    const counts = new Map<string, number>();
    const sorted = [...this.entries.values()].sort(
      (a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id),
    );
    let kept = 0;
    for (const entry of sorted) {
      const count = counts.get(entry.scopeTag) ?? 0;
      if (count >= maxPerScope || kept >= maxRecords) {
        this.discard(entry);
      } else {
        counts.set(entry.scopeTag, count + 1);
        kept++;
      }
    }
  }

  async start(scope: NetworkCaptureScope) {
    if (this.disposed) throw new Error('Network recorder is closed');
    const key = scopeKey(scope);
    let capture = this.active.get(key);
    if (!capture) {
      const startedAt = this.now();
      capture = {
        id: startedAt + '-' + randomUUID(),
        ticket: ++this.ticket,
        startedAt,
        scope: { ...scope },
        ready: mkdir(this.directory, { recursive: true, mode: 0o700 }).then(
          () => this.checkDirectory(),
        ),
      };
      this.active.set(key, capture);
    }
    try {
      await capture.ready;
      await this.cleanup();
      return { captureId: capture.id };
    } catch (error) {
      if (this.active.get(key) === capture) this.active.delete(key);
      throw error;
    }
  }

  async stop(scope: NetworkCaptureScope) {
    const key = scopeKey(scope);
    const captureId = this.active.get(key)?.id ?? null;
    this.active.delete(key);
    return { captureId };
  }

  stopScopeOwner(userId: string, projectId?: string) {
    for (const [key, capture] of this.active) {
      if (
        capture.scope.userId === userId &&
        capture.scope.projectId === projectId
      )
        this.active.delete(key);
    }
  }

  isActive(scope: NetworkCaptureScope) {
    return this.active.has(scopeKey(scope));
  }

  captureTicket() {
    return this.ticket;
  }

  isRetained(handle: NetworkRequestHandle) {
    const entry = this.handles.get(handle);
    return !!entry && this.retained(entry);
  }

  private retained(entry: Entry) {
    return (
      this.entries.get(entry.name) === entry &&
      entry.startedAt + networkRetentionMs > this.now()
    );
  }

  begin(
    scope: NetworkCaptureScope,
    input: NetworkRequestInput,
    ticket?: number,
  ): NetworkRequestHandle | undefined {
    const key = scopeKey(scope);
    const capture = this.active.get(key);
    const now = this.now();
    const startedAt = Math.floor(input.startedAt ?? now);
    if (
      !capture ||
      !Number.isFinite(startedAt) ||
      startedAt > now ||
      startedAt < capture.startedAt ||
      startedAt + networkRetentionMs <= now ||
      (ticket !== undefined && capture.ticket > ticket)
    )
      return;

    const handle = { id: randomUUID(), captureId: capture.id };
    const summary: NetworkRequestSummary = {
      ...handle,
      startedAt: new Date(startedAt).toISOString(),
      url: input.url,
      method: input.method,
      resourceType: input.resourceType,
      state: 'pending',
      redirectedFrom: input.redirectedFrom,
    };
    const scopeTag = this.codec.scopeTag(key);
    const threadTag = this.codec.threadTag(scope.threadId);
    const { serviceTag } = this.codec;
    const name = [startedAt, scopeTag, serviceTag, threadTag, handle.id].join(
      '-',
    );
    const initial = this.codec.encode(name, { ...input, ...summary });
    const entry = this.remember(
      { name, startedAt, scopeTag, serviceTag, threadTag, id: handle.id },
      false,
    );
    this.handles.set(handle, entry);
    const directory = join(this.directory, name);
    entry.writes = capture.ready.then(async () => {
      if (!this.retained(entry)) return;
      await mkdir(directory, { mode: 0o700 });
      await this.writeRecord(directory, initial);
      entry.published = true;
    });
    this.trim();
    // begin is synchronous so the request event can immediately pair its response.
    void entry.writes.catch(() => {
      this.discard(entry);
    });
    return handle;
  }

  private async writeRecord(directory: string, data: Buffer) {
    const temporary = join(directory, randomUUID() + '.tmp');
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(directory, 'record.bin'));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async update(handle: NetworkRequestHandle, patch: NetworkRequestPatch) {
    const entry = this.handles.get(handle);
    if (this.disposed || !entry || !this.retained(entry)) return;
    const write = entry.writes.then(async () => {
      if (!this.retained(entry)) return;
      const previous = await this.codec.read(
        this.directory,
        entry.name,
        'detail',
      );
      const data = this.codec.encode(entry.name, {
        ...previous,
        ...patch,
      });
      await this.writeRecord(join(this.directory, entry.name), data);
    });
    entry.writes = write.catch(() => {});
    return write;
  }

  async list(scope: NetworkCaptureScope, filters: NetworkListFilters = {}) {
    const tag = this.codec.scopeTag(scopeKey(scope));
    await this.cleanup();
    const candidates = [...this.entries.values()].filter(
      (entry) => entry.scopeTag === tag && this.retained(entry),
    );
    const matches: { entry: Entry; summary: NetworkRequestSummary }[] = [];
    // Bound open file descriptors during a filtered history query.
    for (let i = 0; i < candidates.length; i += 16) {
      await Promise.all(
        candidates.slice(i, i + 16).map(async (entry) => {
          try {
            await entry.writes;
            const summary = await this.codec.read(
              this.directory,
              entry.name,
              'summary',
            );
            if (
              (!filters.url || summary.url.includes(filters.url)) &&
              (!filters.method ||
                summary.method.toUpperCase() ===
                  filters.method.toUpperCase()) &&
              (filters.status === undefined ||
                summary.status === filters.status)
            )
              matches.push({ entry, summary });
          } catch (error) {
            if (
              error instanceof NetworkRecordIntegrityError ||
              (error as NodeJS.ErrnoException).code === 'ENOENT'
            )
              return;
            throw error;
          }
        }),
      );
    }
    const current = matches
      .filter(({ entry }) => this.retained(entry))
      .sort(
        (a, b) =>
          b.entry.startedAt - a.entry.startedAt ||
          b.entry.id.localeCompare(a.entry.id),
      );
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(filters.limit ?? 50)));
    return {
      active: this.isActive(scope),
      total: current.length,
      entries: current
        .slice(offset, offset + limit)
        .map(({ summary }) => summary),
    };
  }

  async read(
    scope: NetworkCaptureScope,
    id: string,
  ): Promise<NetworkRequestDetail> {
    const tag = this.codec.scopeTag(scopeKey(scope));
    await this.cleanup();
    const entry = [...this.entries.values()].find(
      (item) => item.id === id && item.scopeTag === tag && this.retained(item),
    );
    if (!entry) throw notFound();
    try {
      await entry.writes;
      const record = await this.codec.read(
        this.directory,
        entry.name,
        'detail',
      );
      if (!this.retained(entry)) throw notFound();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
      throw error;
    }
  }

  private discard(entry: Entry) {
    if (this.entries.get(entry.name) !== entry) return;
    this.entries.delete(entry.name);
    clearTimeout(entry.timer);
    this.deleting.add(entry.name);
    const removal = entry.writes
      .catch(() => {})
      .then(() =>
        rm(join(this.directory, entry.name), { recursive: true, force: true }),
      );
    this.removals.add(removal);
    void removal.catch(logCleanupFailure).finally(() => {
      this.removals.delete(removal);
      this.deleting.delete(entry.name);
    });
  }

  async removeThread(threadId: string) {
    for (const [key, capture] of this.active)
      if (capture.scope.threadId === threadId) this.active.delete(key);
    const tag = this.codec.threadTag(threadId);
    await this.cleanup();
    for (const entry of this.entries.values())
      if (entry.threadTag === tag) this.discard(entry);
    await Promise.all(this.removals);
  }

  cleanup(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.sweeping) return this.sweeping;
    const sweep = this.sweep().finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = sweep;
    return sweep;
  }

  private async sweep() {
    const cutoff = this.now() - networkRetentionMs;
    for (const entry of this.entries.values())
      if (entry.startedAt <= cutoff) this.discard(entry);
    await Promise.all(this.removals);
    try {
      await this.checkDirectory();
      const previouslyPublished = [...this.entries.values()].filter(
        (entry) => entry.published,
      );
      const directories = await readdir(this.directory, {
        withFileTypes: true,
      });
      const found = new Set<string>();
      for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        const file = parseNetworkRecordName(directory.name);
        const startedAt =
          file?.startedAt ?? Number(legacyRecordName.exec(directory.name)?.[1]);
        // Expired files from an older format or key are still eligible for cleanup.
        if (startedAt <= cutoff) {
          await rm(join(this.directory, directory.name), {
            recursive: true,
            force: true,
          });
        } else if (
          file?.serviceTag === this.codec.serviceTag &&
          startedAt <= this.now()
        ) {
          found.add(file.name);
          if (!this.entries.has(file.name) && !this.deleting.has(file.name))
            this.remember(file, true);
        }
      }
      for (const entry of previouslyPublished) {
        if (!found.has(entry.name) && this.entries.get(entry.name) === entry) {
          this.entries.delete(entry.name);
          clearTimeout(entry.timer);
        }
      }
      this.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async dispose() {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    this.active.clear();
    await this.sweeping;
    // Flush queued events but leave retained history for the next service instance.
    await Promise.allSettled(
      [...this.entries.values()].map((entry) => entry.writes),
    );
    await Promise.all(this.removals);
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    this.codec.dispose();
  }
}
