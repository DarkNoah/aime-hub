import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  lstat,
  readdir,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const networkRetentionMs = 15 * 60_000;
const maxPerScope = 512;
const maxRecords = 2048;
const maxRecordBytes = 512 * 1024;
const ownedDirectory = /^(\d+)-[a-f0-9]{64}-[a-f0-9-]{36}$/;

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

type Entry = {
  handle: NetworkRequestHandle;
  scope: NetworkCaptureScope;
  scopeKey: string;
  startedAt: number;
  summary: NetworkRequestSummary;
  directory: string;
  writes: Promise<void>;
  timer: NodeJS.Timeout;
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

/** Only the live index can resolve request IDs. Expired files can also be reaped after a restart. */
export class NetworkCaptureStore {
  private readonly directory: string;
  private readonly encryptionKey = randomBytes(32);
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

  constructor(options: { directory?: string; now?: () => number } = {}) {
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

  // Workspace commands may share the server's OS account. The file alone must
  // not reveal the traffic, and swapping files must not change their owner.
  private seal(key: string, record: NetworkRequestDetail) {
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > maxRecordBytes)
      throw new Error('Network record is too large');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(key + ':' + record.id));
    const ciphertext = Buffer.concat([
      cipher.update(json, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  private async load(entry: Entry): Promise<NetworkRequestDetail> {
    const file = await open(
      join(entry.directory, 'record.bin'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 28 || info.size > maxRecordBytes + 28)
        throw new Error('Invalid record length');
      const data = Buffer.allocUnsafe(info.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (!bytesRead) throw new Error('Incomplete record');
        offset += bytesRead;
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        data.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(entry.scopeKey + ':' + entry.handle.id));
      decipher.setAuthTag(data.subarray(12, 28));
      const plain = Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw new Error('Network record failed integrity verification');
    } finally {
      await file.close();
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
    const entry = this.entries.get(handle.id);
    return (
      entry?.handle === handle &&
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
    const initial = this.seal(key, { ...input, ...summary });
    const hash = createHash('sha256').update(key).digest('hex');
    const directory = join(
      this.directory,
      startedAt + '-' + hash + '-' + handle.id,
    );

    let count = 0;
    let oldest: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.scopeKey === key) {
        oldest ??= entry;
        count++;
      }
    }
    if (oldest && count >= maxPerScope) this.discard(oldest);
    if (this.entries.size >= maxRecords)
      this.discard(this.entries.values().next().value!);

    const timer = setTimeout(
      () => {
        this.discard(entry);
      },
      startedAt + networkRetentionMs - now,
    );
    timer.unref();
    const entry: Entry = {
      handle,
      scope: { ...scope },
      scopeKey: key,
      startedAt,
      summary,
      directory,
      timer,
      writes: capture.ready.then(async () => {
        if (!this.isRetained(handle)) return;
        await mkdir(directory, { mode: 0o700 });
        await writeFile(join(directory, 'record.bin'), initial, {
          mode: 0o600,
          flag: 'wx',
        });
      }),
    };
    this.entries.set(handle.id, entry);
    // begin is synchronous so the request event can immediately pair its response.
    void entry.writes.catch(() => {
      this.discard(entry);
    });
    return handle;
  }

  async update(handle: NetworkRequestHandle, patch: NetworkRequestPatch) {
    const entry = this.entries.get(handle.id);
    if (!entry || !this.isRetained(handle)) return;
    const write = entry.writes.then(async () => {
      if (!this.isRetained(handle)) return;
      const previous = await this.load(entry);
      const data = this.seal(entry.scopeKey, { ...previous, ...patch });
      const temporary = join(entry.directory, randomUUID() + '.tmp');
      try {
        await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(entry.directory, 'record.bin'));
      } finally {
        await rm(temporary, { force: true });
      }
      if (patch.status !== undefined) entry.summary.status = patch.status;
      if (patch.durationMs !== undefined)
        entry.summary.durationMs = patch.durationMs;
      if (patch.state !== undefined) entry.summary.state = patch.state;
    });
    // Keep the last valid on-disk version usable if a patch fails.
    entry.writes = write.catch(() => {});
    return write;
  }

  async list(scope: NetworkCaptureScope, filters: NetworkListFilters = {}) {
    const key = scopeKey(scope);
    const matching = [...this.entries.values()].filter(
      (entry) => entry.scopeKey === key,
    );
    await Promise.all(matching.map((entry) => entry.writes));
    const matches = matching
      .filter(
        ({ handle, summary }) =>
          this.isRetained(handle) &&
          (!filters.url || summary.url.includes(filters.url)) &&
          (!filters.method ||
            summary.method.toUpperCase() === filters.method.toUpperCase()) &&
          (filters.status === undefined || summary.status === filters.status),
      )
      .sort((a, b) => b.startedAt - a.startedAt);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
    const limit = Math.min(100, Math.max(1, Math.trunc(filters.limit ?? 50)));
    return {
      active: this.isActive(scope),
      total: matches.length,
      entries: matches
        .slice(offset, offset + limit)
        .map((entry) => ({ ...entry.summary })),
    };
  }

  async read(
    scope: NetworkCaptureScope,
    id: string,
  ): Promise<NetworkRequestDetail> {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.scopeKey !== scopeKey(scope) ||
      !this.isRetained(entry.handle)
    )
      throw notFound();
    await entry.writes;
    if (!this.isRetained(entry.handle)) throw notFound();
    try {
      const record = await this.load(entry);
      if (!this.isRetained(entry.handle)) throw notFound();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
      throw error;
    }
  }

  private discard(entry: Entry) {
    if (!this.entries.delete(entry.handle.id)) return;
    clearTimeout(entry.timer);
    const removal = entry.writes
      .catch(() => {})
      .then(() => rm(entry.directory, { recursive: true, force: true }));
    this.removals.add(removal);
    void removal
      .catch(logCleanupFailure)
      .finally(() => this.removals.delete(removal));
  }

  async removeThread(threadId: string) {
    for (const [key, capture] of this.active)
      if (capture.scope.threadId === threadId) this.active.delete(key);
    for (const entry of this.entries.values())
      if (entry.scope.threadId === threadId) this.discard(entry);
    await Promise.all(this.removals);
  }

  cleanup(): Promise<void> {
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
      const directories = await readdir(this.directory, {
        withFileTypes: true,
      });
      // The timestamp never changes on updates. Other instances' live directories are never entered.
      for (const directory of directories) {
        const match =
          directory.isDirectory() && ownedDirectory.exec(directory.name);
        if (match && Number(match[1]) <= cutoff)
          await rm(join(this.directory, directory.name), {
            recursive: true,
            force: true,
          });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async dispose() {
    this.disposed = true;
    clearInterval(this.sweepTimer);
    this.active.clear();
    for (const entry of this.entries.values()) this.discard(entry);
    await Promise.all(this.removals);
    await this.sweeping;
    this.encryptionKey.fill(0);
  }
}
