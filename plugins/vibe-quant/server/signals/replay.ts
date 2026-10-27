import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import type {
  StrategyReplayBatch,
  StrategyReplayFrame,
} from '../../replay-types.js';
import { monitorExecutionModel } from '../../signal-types.js';
import type { BacktestInput } from '../../strategy-types.js';
import type { MarketStore } from '../clickhouse.js';
import type { QuantConfig } from '../config.js';
import { ensurePython } from '../python.js';
import type { StateStore } from '../state-store.js';
import { runPython } from '../strategies/runner.js';
import { collectSnapshot } from '../strategies/snapshot.js';
import type { StrategyStore } from '../strategies/store.js';
import { StrategyError } from '../strategies/schema.js';
import type { MonitorStore } from './store.js';

const timestamp = z.number().int().positive().safe();
const inputSchema = z
  .object({
    session: z.string().uuid(),
    from: timestamp,
    after: timestamp.optional(),
    times: z.array(timestamp).min(1).max(500),
  })
  .refine((value) =>
    value.times.every(
      (time, index) =>
        time > value.from && (!index || time > value.times[index - 1]),
    ),
  );

interface Session {
  owner: string;
  fingerprint: string;
  directory: string;
  through: number;
  frames: Map<number, StrategyReplayFrame>;
  touched: number;
  abort: AbortController;
  task?: Promise<StrategyReplayBatch>;
}
type Dependencies = {
  records: StrategyStore;
  monitors: MonitorStore;
  state: StateStore;
  store: MarketStore;
  config: QuantConfig;
};

/** Disposable replay checkpoints are isolated from monitor leases, history and notification delivery. */
export class StrategyReplaySessions {
  private sessions = new Map<string, Session>();
  private pending = new Map<
    string,
    { owner: string; abort: AbortController; done: Promise<void> }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private context: PluginContext,
    private get: () => Dependencies,
    private python = ensurePython,
    private execute = runPython,
  ) {}

  async stop() {
    clearTimeout(this.timer);
    const pending = [...this.pending.values()];
    pending.forEach((task) => task.abort.abort());
    await Promise.all(pending.map((task) => task.done));
    clearTimeout(this.timer);
    await Promise.all([...this.sessions.keys()].map((key) => this.remove(key)));
  }

  private async remove(key: string) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    session.abort.abort();
    await session.task?.catch(() => {});
    await rm(session.directory, { recursive: true, force: true });
  }

  async release(owner: string, monitor: string, token: string) {
    const key = `${owner}:${monitor}:${token}`;
    const pending = this.pending.get(key);
    pending?.abort.abort();
    await pending?.done;
    await this.remove(key);
  }

  private sweep() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void Promise.all(
        [...this.sessions]
          .filter(([, session]) => Date.now() - session.touched > 10 * 60_000)
          .map(([key]) => this.remove(key)),
      ).finally(() => {
        if (this.sessions.size) this.sweep();
      });
    }, 60_000);
    this.timer.unref();
  }

  async calculate(
    owner: string,
    monitorId: string,
    input: z.infer<typeof inputSchema>,
    signal: AbortSignal,
  ): Promise<StrategyReplayBatch> {
    const key = `${owner}:${monitorId}:${input.session}`;
    if (this.pending.has(key)) throw new StrategyError('REPLAY_BUSY', 409);
    const owners = new Map([
      ...[...this.sessions].map(
        ([key, session]) => [key, session.owner] as const,
      ),
      ...[...this.pending].map(([key, task]) => [key, task.owner] as const),
    ]);
    if (
      !owners.has(key) &&
      (owners.size >= 32 ||
        [...owners.values()].filter((value) => value === owner).length >= 16)
    )
      throw new StrategyError('REPLAY_SESSION_LIMIT', 429);
    const abort = new AbortController();
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.pending.set(key, { owner, abort, done });
    try {
      return await this.calculateSession(
        owner,
        monitorId,
        input,
        AbortSignal.any([signal, abort.signal]),
      );
    } finally {
      this.pending.delete(key);
      complete();
    }
  }

  private async calculateSession(
    owner: string,
    monitorId: string,
    input: z.infer<typeof inputSchema>,
    signal: AbortSignal,
  ): Promise<StrategyReplayBatch> {
    const { records, monitors, state, store, config } = this.get();
    const monitor = await monitors.get(monitorId, owner);
    if (monitor.config.simulation_engine === 'tqsdk')
      throw new StrategyError('TQ_INTERACTIVE_REPLAY_UNSUPPORTED', 409);
    if (monitor.deleted || !monitor.enabled || monitor.engine !== config.engine)
      throw new StrategyError('REPLAY_STRATEGY_UNAVAILABLE', 409);
    const strategy = await records.storedStrategy(monitor.strategy_id);
    if (!strategy.enabled || (strategy.status ?? 'active') !== 'active')
      throw new StrategyError('REPLAY_STRATEGY_UNAVAILABLE', 409);
    const version = await records.version(owner, monitor.config.version_id);
    signal.throwIfAborted();
    if (version.strategy_id !== monitor.strategy_id)
      throw new StrategyError('VERSION_NOT_FOUND', 404);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          monitor.engine,
          monitor.config,
          version.source_hash,
          input.from,
        ]),
      )
      .digest('hex');
    const key = `${owner}:${monitorId}:${input.session}`;
    let session = this.sessions.get(key);
    if (session && session.fingerprint !== fingerprint)
      throw new StrategyError('REPLAY_CONFIG_CHANGED', 409);
    if (!session) {
      if (input.after) throw new StrategyError('REPLAY_FRAME_EXPIRED', 409);
      const root = join(
        await this.context.runtime.ensureWorkspace(),
        'strategy-replays',
      );
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, 'replay-'));
      session = {
        owner,
        fingerprint,
        directory,
        through: 0,
        frames: new Map(),
        touched: Date.now(),
        abort: new AbortController(),
      };
      this.sessions.set(key, session);
      await writeFile(join(directory, 'strategy.py'), version.source, {
        mode: 0o600,
      });
      this.sweep();
    }
    if (session.task) throw new StrategyError('REPLAY_BUSY', 409);
    session.touched = Date.now();
    const active = session;
    const abort = AbortSignal.any([
      signal,
      active.abort.signal,
      AbortSignal.timeout(120_000),
    ]);
    const task = async () => {
      const times = input.times.filter((time) => time > active.through);
      if (
        input.times.some(
          (time) => time <= active.through && !active.frames.has(time),
        )
      )
        throw new StrategyError('REPLAY_FRAME_EXPIRED', 409);
      if (times.length) {
        if (active.frames.size + times.length > 20_000)
          throw new StrategyError('REPLAY_FRAME_LIMIT', 400);
        const runConfig: BacktestInput = {
          ...monitor.config,
          execution_model: monitorExecutionModel(monitor.config),
          parameters: { ...version.parameters, ...monitor.config.parameters },
          start: Math.max(1, input.from - monitor.config.warmup_days * 86400),
          end: times.at(-1)!,
          slippage_ticks: 0,
          participation_rate: 1,
          annualization: 252,
          risk_free_rate: 0,
          benchmark_symbol: monitor.config.symbol,
        };
        // Re-read the bounded input window to preserve cross-period aggregation
        // and old contracts across rolls. Python only processes events after its checkpoint.
        const [raw, python] = await Promise.all([
          collectSnapshot(store, state, monitor.engine, runConfig, abort),
          this.python(this.context.runtime, abort),
        ]);
        abort.throwIfAborted();
        await writeFile(
          join(active.directory, 'market.json'),
          JSON.stringify(raw),
          { mode: 0o600 },
        );
        await writeFile(
          join(active.directory, 'request.json'),
          JSON.stringify({ times, monitor_id: monitor.id }),
          { mode: 0o600 },
        );
        await this.execute(
          python,
          [
            join(
              this.context.runtime.paths.pluginRoot,
              'worker/strategy_replay.py',
            ),
            join(this.context.runtime.paths.pluginRoot, 'sdk'),
            active.directory,
          ],
          active.directory,
          abort,
          90_000,
        );
        abort.throwIfAborted();
        const output = join(active.directory, 'result.json');
        if ((await stat(output)).size > 64 * 1024 * 1024)
          throw new Error('回放策略结果过大，请缩短回放范围');
        const result = JSON.parse(
          await readFile(output, 'utf8'),
        ) as StrategyReplayBatch;
        if (
          !Array.isArray(result.frames) ||
          result.frames.length !== times.length ||
          result.through !== times.at(-1) ||
          result.frames.some((frame, index) => frame.time !== times[index])
        )
          throw new Error('回放策略返回了无效结果');
        await rename(
          join(active.directory, 'checkpoint.next.json'),
          join(active.directory, 'checkpoint.json'),
        );
        for (const frame of result.frames) active.frames.set(frame.time, frame);
        active.through = result.through;
      }
      return {
        frames: input.times.map((time) => active.frames.get(time)!),
        through: active.through,
      };
    };
    active.task = task();
    try {
      return await active.task;
    } finally {
      active.task = undefined;
      active.touched = Date.now();
    }
  }
}

export function strategyReplayRoutes(sessions: StrategyReplaySessions) {
  const api = new Hono<PluginHttpEnv>();
  api.onError((error, c) =>
    error instanceof StrategyError
      ? c.json({ code: error.code }, error.status)
      : c.json(
          {
            code: c.req.raw.signal.aborted
              ? 'REPLAY_CANCELLED'
              : 'REPLAY_FAILED',
            message: c.req.raw.signal.aborted
              ? '用户中止了操作'
              : error.message,
          },
          503,
        ),
  );
  api.post('/monitors/:id/replay', async (c) => {
    if (!c.get('isAdmin'))
      throw new StrategyError('SCRIPT_EXECUTION_ADMIN_REQUIRED', 403);
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new StrategyError('INVALID_REPLAY_QUERY');
    return c.json(
      await sessions.calculate(
        c.get('userId'),
        c.req.param('id'),
        parsed.data,
        c.req.raw.signal,
      ),
    );
  });
  api.delete('/monitors/:id/replay/:session', async (c) => {
    await sessions.release(
      c.get('userId'),
      c.req.param('id'),
      c.req.param('session'),
    );
    return c.json({ ok: true });
  });
  return api;
}
