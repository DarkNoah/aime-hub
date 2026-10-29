import { randomInt } from 'node:crypto';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { LocalSandbox, type LocalSandboxOptions } from '@mastra/core/workspace';
import type { ToolExecutionContext } from '@mastra/core/tools';
import type { ThreadCommandSession } from '@aime/shared/threads';
import { spawnPty, type CommandHandle } from './pty.js';
import type { CommandInput } from './schema.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_SESSIONS = 32;
const COMPLETED_TTL_MS = 10 * 60_000;

class CommandSession {
  handle!: CommandHandle;
  ready!: Promise<CommandHandle>;
  stopping?: Promise<void>;
  createdAt = new Date().toISOString();
  output = '';
  bytes = 0;
  droppedBytes = 0;
  exitCode?: number;
  expiry?: ReturnType<typeof setTimeout>;
  busy = false;

  constructor(
    readonly input: CommandInput,
    readonly workdir: string,
  ) {}

  append = (data: string) => {
    this.output += data;
    this.bytes += Buffer.byteLength(data);
    if (this.bytes > MAX_BUFFER_BYTES) {
      const buffer = Buffer.from(this.output);
      let start = buffer.length - MAX_BUFFER_BYTES;
      // Do not split a UTF-8 character when retaining the tail.
      while ((buffer[start] & 0xc0) === 0x80) start++;
      this.output = buffer.subarray(start).toString();
      this.droppedBytes += start;
      this.bytes -= start;
    }
  };

  take(maxTokens: number) {
    const originalBytes = this.bytes + this.droppedBytes;
    const buffer = Buffer.from(this.output);
    let end = Math.min(buffer.length, maxTokens * 4);
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    const output = buffer.subarray(0, end).toString();
    const truncated = originalBytes > end;
    this.output = '';
    this.bytes = this.droppedBytes = 0;
    return {
      output,
      original_token_count: Math.ceil(originalBytes / 4),
      truncated,
    };
  }
}

/** Sessions belong to this Workspace instance, never a global PID registry. */
export class CommandSandbox extends LocalSandbox {
  private sessions = new Map<number, CommandSession>();
  private starting = new Set<Promise<unknown>>();
  private closing = false;
  private listeners = new Set<() => void>();

  constructor(
    options: LocalSandboxOptions,
    private refreshEnv?: (userId?: string) => Promise<Record<string, string>>,
  ) {
    super(options);
  }

  listCommandSessions(): ThreadCommandSession[] {
    return [...this.sessions].map(([sessionId, session]) => ({
      sessionId,
      cmd: session.input.cmd,
      workdir: session.workdir,
      tty: session.input.tty,
      pid: session.handle?.pid,
      status: session.stopping
        ? 'stopping'
        : session.exitCode !== undefined
          ? 'exited'
          : session.handle
            ? 'running'
            : 'starting',
      createdAt: session.createdAt,
      exitCode: session.exitCode,
    }));
  }

  onCommandSessionsChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  async cleanupCommandSession(id: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      // Cleanup can arrive while environment resolution or PTY startup is pending.
      const handle = await session.ready.catch(() => undefined);
      if (handle) {
        await handle.kill();
        await handle.done;
      }
      this.release(id);
    })();
    this.changed();
    try {
      await session.stopping;
    } catch (error) {
      session.stopping = undefined;
      this.changed();
      throw error;
    }
  }

  async exec(input: CommandInput, signal?: AbortSignal, userId?: string) {
    const startedAt = performance.now();
    signal?.throwIfAborted();
    if (this.closing) throw new Error('Command sandbox is closing');
    if (this.sessions.size >= MAX_SESSIONS)
      throw new Error(
        'Too many command sessions. Read completed sessions or stop running commands first.',
      );
    let id: number;
    do {
      id = randomInt(1, 2_147_483_647);
    } while (this.sessions.has(id));
    const session = new CommandSession(
      input,
      resolve(this.workingDirectory, input.workdir ?? '.'),
    );
    session.busy = true;
    this.sessions.set(id, session);
    const startup = this.spawn(input, session, signal, userId);
    session.ready = startup;
    this.starting.add(startup);
    this.changed();
    try {
      session.handle = await startup;
      session.handle.done.then((code) => {
        session.exitCode = code;
        if (this.sessions.get(id) === session) {
          session.expiry = setTimeout(() => this.release(id), COMPLETED_TTL_MS);
          session.expiry.unref();
          this.changed();
        }
      });
      this.changed();
      if (this.closing) throw new Error('Command sandbox is closing');
      return await this.read(
        id,
        session,
        input.yield_time_ms,
        input.max_output_tokens,
        startedAt,
        signal,
      );
    } catch (error) {
      await session.handle?.kill();
      this.release(id);
      throw error;
    } finally {
      this.starting.delete(startup);
      session.busy = false;
    }
  }

  async write(
    id: number,
    chars: string,
    waitMs: number,
    maxTokens: number,
    signal?: AbortSignal,
  ) {
    const startedAt = performance.now();
    signal?.throwIfAborted();
    const session = this.sessions.get(id);
    if (!session || this.closing)
      throw new Error(
        `Unknown command session: ${id}. Sessions only exist in the current conversation and server lifetime.`,
      );
    if (session.busy)
      throw new Error(
        `Command session ${id} is already being read; wait for that call to finish.`,
      );
    session.busy = true;
    try {
      if (chars) await session.handle.write(chars);
      return await this.read(id, session, waitMs, maxTokens, startedAt, signal);
    } finally {
      session.busy = false;
    }
  }

  private async spawn(
    input: CommandInput,
    session: CommandSession,
    signal?: AbortSignal,
    userId?: string,
  ): Promise<CommandHandle> {
    await this.ensureRunning();
    // A fresh overlay also removes deleted settings, without inheriting host secrets.
    // Keep credentials local to this invocation, including concurrent commands.
    const env = this.refreshEnv ? await this.refreshEnv(userId) : this.getEnv();
    signal?.throwIfAborted();
    if (this.closing) throw new Error('Command sandbox is closing');
    const shell =
      input.shell ?? process.env.SHELL ?? userInfo().shell ?? '/bin/sh';
    const args = [input.login ? '-lc' : '-c', input.cmd];
    const command = `exec ${[shell, ...args].map(quote).join(' ')}`;
    const cwd = resolve(this.workingDirectory, input.workdir ?? '.');
    if (input.tty)
      return spawnPty(this, shell, args, command, cwd, env, session.append);
    const handle = await this.processes.spawn(command, {
      cwd,
      env,
      stdinMode: 'pipe',
      maxRetainedBytes: 0,
      onStdout: session.append,
      onStderr: session.append,
    });
    return {
      pid: handle.pid,
      done: handle.wait().then((result) => result.exitCode),
      write: (chars) => handle.sendStdin(chars),
      kill: () => handle.kill(),
      release: () => this.processes.release(handle.pid),
    };
  }

  private async read(
    id: number,
    session: CommandSession,
    waitMs: number,
    maxTokens: number,
    startedAt: number,
    signal?: AbortSignal,
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      await Promise.race([
        session.handle.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal?.reason ?? new Error('Command aborted'));
          signal?.addEventListener('abort', abort, { once: true });
        }),
      ]);
      const result = {
        ...session.take(maxTokens),
        wall_time_seconds: (performance.now() - startedAt) / 1000,
        ...(session.exitCode === undefined
          ? { session_id: id }
          : { exit_code: session.exitCode }),
      };
      if (session.exitCode !== undefined) this.release(id);
      return result;
    } catch (error) {
      await session.handle.kill();
      this.release(id);
      throw error;
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }

  private release(id: number) {
    clearTimeout(this.sessions.get(id)?.expiry);
    this.sessions.get(id)?.handle?.release();
    if (this.sessions.delete(id)) this.changed();
  }

  private async closeSessions() {
    this.closing = true;
    await Promise.allSettled([...this.starting]);
    await Promise.all(
      [...this.sessions.values()].map((session) => session.handle?.kill()),
    );
    for (const id of this.sessions.keys()) this.release(id);
  }

  override async stop() {
    try {
      await this.closeSessions();
      await super.stop();
    } finally {
      this.closing = false;
    }
  }

  override async destroy() {
    await this.closeSessions();
    await super.destroy();
  }
}

export async function commandSandbox(context: ToolExecutionContext) {
  const workspace = context.workspace;
  if (!workspace || !(workspace.sandbox instanceof CommandSandbox))
    throw new Error(
      'This tool requires the current conversation command sandbox',
    );
  if (workspace.status !== 'ready') await workspace.init();
  return workspace.sandbox;
}
