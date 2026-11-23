import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { LocalSandbox, type LocalSandboxOptions } from '@mastra/core/workspace';
import type { ToolExecutionContext } from '@mastra/core/tools';
import type { ThreadCommandSession } from '@aime/shared/threads';
import { withAbortSignal } from '../../../lib/abort.js';
import { spawnPty, type CommandHandle } from './pty.js';
import type { CommandInput } from './schema.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_SESSIONS = 32;
const COMPLETED_TTL_MS = 10 * 60_000;

export class UnknownCommandSessionError extends Error {
  constructor(id: string | number) {
    super(
      `Unknown command session: ${id}. Sessions only exist in the current conversation and server lifetime.`,
    );
  }
}

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
  readonly events = new EventEmitter();
  private readOffset = 0;

  constructor(
    readonly input: CommandInput,
    readonly workdir: string,
    readonly backgroundTask: boolean,
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
    this.events.emit('output');
  };

  get hasUnreadOutput() {
    return this.droppedBytes + this.bytes > this.readOffset;
  }

  take(maxTokens: number, finalTaskResult = false) {
    // Incremental readers must not consume the native background task's final result.
    const offset = finalTaskResult ? 0 : this.readOffset;
    const originalBytes = this.bytes + this.droppedBytes - offset;
    const buffer = Buffer.from(this.output);
    const start = Math.max(0, offset - this.droppedBytes);
    let end = Math.min(buffer.length, start + maxTokens * 4);
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    const output = buffer.subarray(start, end).toString();
    const truncated = originalBytes > end - start;
    if (this.backgroundTask) {
      if (!finalTaskResult) this.readOffset = this.droppedBytes + end;
    } else {
      this.output = '';
      this.bytes = this.droppedBytes = 0;
    }
    return {
      output,
      original_token_count: Math.ceil(originalBytes / 4),
      truncated,
    };
  }
}

/** Sessions belong to this Workspace instance, never a global PID registry. */
export class CommandSandbox extends LocalSandbox {
  private sessions = new Map<number | string, CommandSession>();
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
    return [...this.sessions]
      .filter(
        (entry): entry is [number, CommandSession] =>
          typeof entry[0] === 'number' && !entry[1].backgroundTask,
      )
      .map(([sessionId, session]) => ({
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
    if (!session || session.backgroundTask) return;
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      // Cleanup can arrive while environment resolution or PTY startup is pending.
      const handle = await session.ready.catch(() => undefined);
      await handle?.kill();
      this.release(id, session);
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

  async exec(
    input: CommandInput,
    {
      signal,
      userId,
      backgroundTask = false,
      taskId,
    }: {
      signal?: AbortSignal;
      userId?: string;
      backgroundTask?: boolean;
      taskId?: string;
    } = {},
  ) {
    const startedAt = performance.now();
    signal?.throwIfAborted();
    if (this.closing) throw new Error('Command sandbox is closing');
    if (this.sessions.size >= MAX_SESSIONS)
      throw new Error(
        'Too many command sessions. Read completed sessions or stop running commands first.',
      );
    let id: number | string;
    if (backgroundTask && taskId) {
      if (this.sessions.has(taskId))
        throw new Error('This background command is already running.');
      id = taskId;
    } else {
      do {
        id = randomInt(1, 2_147_483_647);
      } while (this.sessions.has(id));
    }
    const session = new CommandSession(
      input,
      resolve(this.workingDirectory, input.workdir ?? '.'),
      backgroundTask,
    );
    session.busy = !backgroundTask;
    this.sessions.set(id, session);
    const startup = this.spawn(input, session, signal, userId);
    session.ready = startup;
    this.starting.add(startup);
    this.changed();
    try {
      session.handle = await startup;
      session.handle.done.then((code) => {
        session.exitCode = code;
        session.events.emit('exit');
        if (this.sessions.get(id) === session) {
          if (!backgroundTask && input.yield_time_ms !== undefined) {
            session.expiry = setTimeout(
              () => this.release(id, session),
              COMPLETED_TTL_MS,
            );
            session.expiry.unref();
          }
          this.changed();
        }
      });
      this.changed();
      if (this.closing) throw new Error('Command sandbox is closing');
      return await this.read(
        id,
        session,
        backgroundTask ? undefined : input.yield_time_ms,
        input.max_output_tokens,
        startedAt,
        signal,
        true,
      );
    } catch (error) {
      try {
        await session.handle?.kill();
      } finally {
        this.release(id, session);
      }
      throw error;
    } finally {
      this.starting.delete(startup);
      if (!backgroundTask) session.busy = false;
    }
  }

  async write(
    id: string | number,
    chars: string,
    waitMs: number,
    maxTokens: number,
    signal?: AbortSignal,
    terminate = false,
  ) {
    const startedAt = performance.now();
    signal?.throwIfAborted();
    const session = this.sessions.get(id);
    if (
      !session ||
      this.closing ||
      (session.backgroundTask
        ? typeof id !== 'string'
        : session.input.yield_time_ms === undefined)
    )
      throw new UnknownCommandSessionError(id);

    // Termination must be possible while a read or a pipe write is pending.
    if (!terminate && session.busy)
      throw new Error(
        `Command session ${id} is already being read; wait for that call to finish.`,
      );
    if (!terminate) session.busy = true;
    try {
      const handle = await withAbortSignal(signal, () => session.ready);
      if (terminate) {
        await withAbortSignal(signal, () => handle.kill());
      } else if (chars) {
        await withAbortSignal(signal, () => handle.write(chars));
      }
      return await this.read(
        id,
        session,
        waitMs,
        maxTokens,
        startedAt,
        signal,
        false,
      );
    } catch (error) {
      if (typeof id === 'number' && signal?.aborted)
        await this.cleanupCommandSession(id);
      throw error;
    } finally {
      if (!terminate) session.busy = false;
    }
  }

  private async spawn(
    input: CommandInput,
    session: CommandSession,
    signal?: AbortSignal,
    userId?: string,
  ): Promise<CommandHandle> {
    // A fresh overlay also removes deleted settings, without inheriting host secrets.
    // Keep credentials local to this invocation, including concurrent commands.
    const env = await withAbortSignal(signal, async () => {
      await this.ensureRunning();
      signal?.throwIfAborted();
      return this.refreshEnv ? this.refreshEnv(userId) : this.getEnv();
    });
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
    const done = handle.wait().then((result) => result.exitCode);
    return {
      pid: handle.pid,
      done,
      write: (chars) => handle.sendStdin(chars),
      async kill() {
        await handle.kill();
        await done;
      },
      release: () => this.processes.release(handle.pid),
    };
  }

  private async read(
    id: number | string,
    session: CommandSession,
    waitMs: number | undefined,
    maxTokens: number,
    startedAt: number,
    signal: AbortSignal | undefined,
    owner: boolean,
  ) {
    if (waitMs === undefined) {
      await withAbortSignal(signal, () => session.handle.done);
    } else if (session.exitCode === undefined && waitMs > 0) {
      const wakeOnOutput = session.backgroundTask && !owner;
      if (!wakeOnOutput || !session.hasUnreadOutput) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let wake!: () => void;
        try {
          await withAbortSignal(
            signal,
            () =>
              new Promise<void>((resolve) => {
                wake = resolve;
                session.events.once('exit', wake);
                if (wakeOnOutput) session.events.once('output', wake);
                timer = setTimeout(wake, waitMs);
              }),
          );
        } finally {
          clearTimeout(timer);
          if (wake) {
            session.events.off('exit', wake);
            session.events.off('output', wake);
          }
        }
      }
    }
    const result = {
      ...session.take(maxTokens, owner && session.backgroundTask),
      wall_time_seconds: (performance.now() - startedAt) / 1000,
      ...(session.exitCode === undefined
        ? { session_id: id }
        : { exit_code: session.exitCode }),
    };
    if (session.exitCode !== undefined && (owner || !session.backgroundTask))
      this.release(id, session);
    return result;
  }

  private release(id: number | string, session: CommandSession) {
    if (this.sessions.get(id) !== session) return;
    clearTimeout(session.expiry);
    session.handle?.release();
    if (this.sessions.delete(id)) this.changed();
  }

  private async closeSessions() {
    this.closing = true;
    await Promise.allSettled([...this.starting]);
    await Promise.all(
      [...this.sessions.values()].map((session) => session.handle?.kill()),
    );
    for (const [id, session] of this.sessions) this.release(id, session);
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
  if (workspace.status !== 'ready')
    await withAbortSignal(context.abortSignal, () => workspace.init());
  return workspace.sandbox;
}
