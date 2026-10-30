import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PluginContext } from '@app/plugin-sdk/server';
import type { SyncStatus } from '../../shared.js';
import type { QuantConfig } from '../config.js';
import type { StrategySignal } from '../../signal-types.js';
import { monitorExecutionModel } from '../../signal-types.js';
import { strategyNotifications } from '../../strategy-notifications.js';
import type { StrategyStore } from '../strategies/store.js';
import { StrategyError } from '../strategies/schema.js';
import { ensurePython } from '../python.js';
import type { MonitorStore, StoredMonitor } from './store.js';
import { runSignalProcess } from './process.js';
import type { SignalHistoryBatch } from '../../signal-history.js';

const signalSchema = z.object({
  id: z.string(),
  type: z.enum(['entry', 'exit']),
  side: z.enum(['long', 'short', 'unknown']),
  symbol: z.string(),
  time: z.number().finite(),
  reason: z.string(),
  price: z.number().finite().nullable(),
  chart_time: z.number().finite().optional(),
});
const overlaySchema = z.object({
  updated_at: z.number().finite(),
  levels: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      entry_signal_id: z.string(),
      chart_time: z.number().finite().optional(),
      time: z.number().finite(),
      stop_loss: z.number().finite().nullable(),
      take_profit: z.number().finite().nullable(),
      chart_stop_loss: z.number().finite().nullable(),
      chart_take_profit: z.number().finite().nullable(),
    }),
  ),
});
type Running = {
  abort: AbortController;
  token: string;
  promise: Promise<void>;
  status: 'starting' | 'running';
  message: string;
  pauseReason?: string;
};
type MonitorUser = { id: string; role: string | null; banned: boolean | null };
export type MarketRequest = (
  owner: string,
  path: string,
  init: RequestInit,
) => Promise<Response>;
export class SignalWorker {
  private current = new Map<string, Running>();
  private retry = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private ticking?: Promise<void>;
  constructor(
    private context: PluginContext,
    private monitors: MonitorStore,
    private records: StrategyStore,
    private market: MarketRequest,
    private status: () => SyncStatus,
    private preparePython = ensurePython,
    private config?: () => QuantConfig,
  ) {}
  start() {
    this.stopped = false;
    this.wake();
  }
  wake(retryNow = false) {
    if (retryNow) this.retry.clear();
    if (this.stopped || this.ticking) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.ticking = this.tick()
        .catch(() => {
          for (const run of this.current.values())
            this.pause(run, '策略状态或账号权限校验失败，已暂停并等待重试');
        })
        .finally(() => {
          this.ticking = undefined;
          if (!this.stopped) this.timer = setTimeout(() => this.wake(), 3000);
        });
    }, 0);
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const run of this.current.values())
      this.pause(run, '策略监听服务已停止');
    await this.ticking;
    await Promise.allSettled(
      [...this.current.values()].map((run) => run.promise),
    );
  }
  private pause(run: Running, reason: string) {
    run.pauseReason ??= reason;
    run.abort.abort();
  }
  private async user(owner: string): Promise<MonitorUser | undefined> {
    const [user] = await this.context.database.query(
      'SELECT id, role, banned FROM users WHERE id=$1',
      [owner],
    );
    return user;
  }
  private async pauseReason(row: StoredMonitor): Promise<string | undefined> {
    const current = await this.monitors
      .get(row.id, row.user_id)
      .catch((error) => {
        if (
          error instanceof StrategyError &&
          error.code === 'MONITOR_NOT_FOUND'
        )
          return undefined;
        throw error;
      });
    if (!current || current.deleted) return '该策略监听已移除';
    if (current.service_id !== this.monitors.serviceId)
      return '该策略监听由其他服务负责运行';
    if (!current.enabled) return '该策略监听已暂停，请开启计算开关';
    const [strategy, user] = await Promise.all([
      this.records.storedStrategy(current.strategy_id).catch((error) => {
        if (
          error instanceof StrategyError &&
          error.code === 'STRATEGY_NOT_FOUND'
        )
          return undefined;
        throw error;
      }),
      this.user(current.user_id),
    ]);
    if (!strategy) return '策略不存在，无法继续计算';
    if (strategy.status === 'deleted') return '策略已删除，请先恢复策略';
    if (strategy.status === 'archived') return '策略已归档，请先取消归档';
    if (!strategy.enabled) return '策略已停用，请先在策略管理中启用';
    if ((strategy.status ?? 'active') !== 'active')
      return '策略状态异常，无法继续计算';
    if (!user) return '加载该策略的账号已被删除';
    if (user.banned) return '加载该策略的账号已被封禁';
    if (!user.role?.split(',').includes('admin'))
      return '加载该策略的账号已无管理员权限，无法运行策略';
  }
  private async tick() {
    if (this.stopped) return;
    await this.context.assertEnabled();
    await this.monitors.cleanupDeleted();
    const rows = await this.monitors.list();
    const candidates = new Map(
      rows
        .filter(
          (row) =>
            row.enabled &&
            !row.deleted &&
            (!row.service_id || row.service_id === this.monitors.serviceId) &&
            (row.config.simulation_engine === 'tqsdk' ||
              row.engine === this.status().engine),
        )
        .map((row) => [row.id, row]),
    );
    await Promise.all(
      [...this.current].map(async ([id, run]) => {
        // Read disabled rows as well so their actual stop reason is retained.
        const row = rows.find((item) => item.id === id);
        const reason = !row ? '该策略监听已移除' : await this.pauseReason(row);
        if (reason) {
          this.pause(run, reason);
          return;
        }
        if (!candidates.has(id)) {
          this.pause(run, '行情引擎已切换，策略监听已停止');
          return;
        }
        if (
          this.status().state === 'standby' &&
          row!.config.simulation_engine !== 'tqsdk'
        ) {
          this.pause(run, '行情采集由其他服务接管，等待恢复实时计算');
          return;
        }
        if (
          !run.abort.signal.aborted &&
          !(await this.monitors.heartbeat(
            id,
            run.token,
            run.status,
            run.message,
          ))
        )
          this.pause(run, '实时计算租约已失效，已停止本次计算');
      }),
    );
    for (let row of candidates.values()) {
      if (
        this.status().state === 'standby' &&
        row.config.simulation_engine !== 'tqsdk'
      )
        continue;
      if (this.stopped || this.current.size >= 8) break;
      if (
        this.current.has(row.id) ||
        (this.retry.get(row.id) ?? 0) > Date.now()
      )
        continue;
      // An unknown user on THIS host does not revoke a different host's user.
      // Legacy tasks can only be adopted after finding the user locally. Once
      // bound, even identical user IDs in independent databases stay isolated.
      if (!row.service_id) {
        if (!(await this.user(row.user_id))) continue;
        const bound = await this.monitors.bindService(row);
        if (!bound) continue;
        row = bound;
      }
      if (this.stopped) break;
      const token = randomUUID();
      if (!(await this.monitors.acquire(row.id, token))) continue;
      const reason = this.stopped
        ? '策略监听服务已停止'
        : await this.pauseReason(row);
      if (reason || this.stopped) {
        await this.monitors.heartbeat(
          row.id,
          token,
          'paused',
          reason ?? '策略监听服务已停止',
          undefined,
          true,
        );
        continue;
      }
      const run: Running = {
        abort: new AbortController(),
        token,
        promise: Promise.resolve(),
        status: 'starting',
        message: '正在加载历史行情',
      };
      this.current.set(row.id, run);
      run.promise = this.execute(row, run)
        .catch(async (error) => {
          this.retry.set(row.id, Date.now() + 30000);
          await this.monitors
            .heartbeat(
              row.id,
              token,
              run.abort.signal.aborted ? 'paused' : 'error',
              run.abort.signal.aborted
                ? (run.pauseReason ?? '实时计算已停止')
                : error instanceof Error
                  ? error.message
                  : '实时计算失败',
              undefined,
              true,
            )
            .catch(() => {});
        })
        .finally(() => this.current.delete(row.id));
    }
  }
  private async execute(row: StoredMonitor, run: Running) {
    const signal = run.abort.signal;
    const native = row.config.simulation_engine === 'tqsdk';
    const credentials = native ? this.config?.() : undefined;
    if (native && (!credentials?.tqUser || !credentials?.tqPassword))
      throw new Error('请先在插件设置中配置天勤账号和密码');
    const root = join(
      await this.context.runtime.ensureWorkspace(),
      'signal-monitors',
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, `${row.id}-`));
    const sessions = new Set<string>();
    try {
      const version = await this.records.version(
        row.user_id,
        row.config.version_id,
      );
      const python = await this.preparePython(this.context.runtime, signal);
      signal.throwIfAborted();
      const runtime = await this.monitors.runtime(row.id, true);
      await writeFile(join(directory, 'strategy.py'), version.source, {
        mode: 0o600,
      });
      await this.records.prepareFactors(version.source, directory);
      await writeFile(
        join(directory, 'config.json'),
        JSON.stringify({
          ...row.config,
          monitor_id: row.id,
          execution_model: monitorExecutionModel(row.config),
          parameters: { ...version.parameters, ...row.config.parameters },
        }),
        { mode: 0o600 },
      );
      if (runtime?.checkpoint)
        await writeFile(
          join(directory, 'checkpoint.json'),
          runtime.checkpoint,
          { mode: 0o600 },
        );
      const handle = async (
        message: Record<string, unknown>,
      ): Promise<unknown> => {
        signal.throwIfAborted();
        if (message.kind === 'credentials' && native)
          return {
            tqUser: credentials!.tqUser,
            tqPassword: credentials!.tqPassword,
          };
        if (message.kind === 'commit' && native) {
          const checkpoint = message.checkpoint as {
            outbox?: {
              batch?: SignalHistoryBatch;
              overlay?: unknown;
              signals?: unknown[];
            };
          };
          if (!checkpoint || !checkpoint.outbox)
            throw new Error('Invalid native checkpoint');
          await handle({ kind: 'checkpoint', checkpoint });
          const outbox = checkpoint.outbox;
          if (outbox.batch)
            await handle({ kind: 'history', batch: outbox.batch });
          if (outbox.overlay)
            await handle({ kind: 'overlay', overlay: outbox.overlay });
          for (const signal of outbox.signals ?? [])
            await handle({ kind: 'signal', signal });
          return true;
        }
        if (message.kind === 'pulse' && native) return true;

        if (message.kind === 'market') {
          if (
            typeof message.path !== 'string' ||
            !/^\/(?:instruments\/[^/]+|history(?:\/range)?|contracts|sessions(?:\/[a-f0-9-]+(?:\/events)?)?)$/.test(
              message.path,
            )
          )
            throw new Error('Invalid market request');
          const url = new URL('http://monitor' + message.path);
          if (message.params && typeof message.params === 'object')
            for (const [key, value] of Object.entries(message.params))
              url.searchParams.set(key, String(value));
          const request = () =>
            this.market(row.user_id, url.pathname + url.search, {
              method:
                typeof message.method === 'string' ? message.method : 'GET',
              headers: { 'Content-Type': 'application/json' },
              body: message.body ? JSON.stringify(message.body) : undefined,
              signal,
            });
          let response = await request();
          for (
            let attempt = 0;
            response.status >= 500 &&
            (message.method ?? 'GET') === 'GET' &&
            attempt < 2;
            attempt++
          ) {
            await response.body?.cancel();
            await delay(500 * (attempt + 1), undefined, { signal });
            response = await request();
          }
          const result = await response.json().catch(() => ({}));
          if (!response.ok)
            throw new Error(
              result.code ??
                `行情读取失败（HTTP ${response.status}，${message.path}）`,
            );
          if (message.path === '/sessions' && typeof result.id === 'string')
            sessions.add(result.id);
          return result;
        }
        if (message.kind === 'checkpoint') {
          const checkpoint = JSON.stringify(message.checkpoint);
          if (checkpoint.length > 32 * 1024 * 1024)
            throw new Error('检查点过大，请暂停后重新添加此标的');
          if (
            !(await this.monitors.heartbeat(
              row.id,
              run.token,
              run.status,
              run.message,
              checkpoint,
            ))
          )
            throw new Error('实时计算租约已失效');
          return true;
        }
        if (message.kind === 'history') {
          const batch = message.batch as SignalHistoryBatch;
          if (
            !batch ||
            !Array.isArray(batch.records) ||
            batch.records.length > 2000
          )
            throw new Error('Invalid history batch');
          for (const record of batch.records) {
            if (
              !(
                native
                  ? ['signal', 'trade', 'order', 'fill']
                  : ['signal', 'trade']
              ).includes(record.kind) ||
              typeof record.id !== 'string' ||
              !Number.isFinite(record.time)
            )
              throw new Error('Invalid history record');
            if (record.kind === 'signal') {
              const raw = signalSchema.parse(record.payload);
              record.id = createHash('sha256')
                .update(`${row.id}:${raw.id}`)
                .digest('hex');
              record.payload = { ...raw, id: record.id, monitor_id: row.id };
            }
          }
          await this.monitors.history.save(row.id, run.token, batch);
          return true;
        }
        if (message.kind === 'overlay') {
          const overlay = overlaySchema.parse(message.overlay);
          if (!(await this.monitors.saveOverlay(row.id, run.token, overlay)))
            throw new Error('实时计算租约已失效');
          return true;
        }
        if (message.kind === 'ready') {
          run.status = 'running';
          run.message = native
            ? '天勤历史已计算，TqSim 实时模拟交易中'
            : '全量历史已计算，实时更新入场与离场记录';
          if (
            !(await this.monitors.heartbeat(
              row.id,
              run.token,
              run.status,
              run.message,
            ))
          )
            throw new Error('实时计算租约已失效');
          return true;
        }
        if (message.kind === 'signal') {
          const raw = signalSchema.parse(message.signal);
          const reason = await this.pauseReason(row);
          if (reason) this.pause(run, reason);
          signal.throwIfAborted();
          if (
            !(await this.monitors.heartbeat(
              row.id,
              run.token,
              run.status,
              run.message,
            ))
          )
            throw new Error('实时计算租约已失效');
          signal.throwIfAborted();
          const event: StrategySignal = {
            ...raw,
            id: createHash('sha256')
              .update(`${row.id}:${raw.id}`)
              .digest('hex'),
            monitor_id: row.id,
          };
          await this.monitors.signal(row.user_id, event, run.token);
          const strategy = await this.records.storedStrategy(row.strategy_id);
          const current = await this.monitors.get(row.id, row.user_id);
          const channels = strategyNotifications(
            current.notifications ?? strategy.notifications,
          ).channels;
          if (
            current.notifications_enabled !== false &&
            current.config.events[event.type]
          ) {
            if (!this.context.notifications)
              throw new Error('宿主通知服务不可用');
            const side =
              event.side === 'long'
                ? '多头'
                : event.side === 'short'
                  ? '空头'
                  : '';
            const time = new Date(event.time * 1000).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
              hour12: false,
            });
            await this.context.notifications.publish({
              userId: row.user_id,
              eventId: event.id,
              title: `${strategy.name} · ${side}${event.type === 'entry' ? '入场' : '离场'}信号`,
              body: `${event.symbol} · v${row.version_number} · ${time}${event.price === null ? '' : ` · 参考价 ${event.price}`}${event.reason ? ` · ${event.reason}` : ''}`,
              url: `/plugins/vibe-quant/?symbol=${encodeURIComponent(row.config.display_symbol ?? row.config.symbol)}`,
              toast: channels.toast?.enabled ?? false,
              desktop: channels.desktop?.enabled ?? false,
              ...(channels.sound?.enabled ? { sound: event.type } : {}),
              marketSignal: {
                type: event.type,
                side: event.side,
                strategyName: strategy.name,
                version: row.version_number,
                symbol: event.symbol,
                time: event.time,
                price: event.price,
                reason: event.reason,
              },
            });
          }
          return true;
        }
        throw new Error('Invalid monitor command');
      };
      await runSignalProcess(
        python,
        [
          join(
            this.context.runtime.paths.pluginRoot,
            native
              ? 'worker/strategy_tq_monitor.py'
              : 'worker/strategy_monitor.py',
          ),
          join(this.context.runtime.paths.pluginRoot, 'sdk'),
          directory,
        ],
        directory,
        signal,
        handle,
        credentials ? [credentials.tqUser, credentials.tqPassword] : [],
      );
    } finally {
      await Promise.allSettled(
        [...sessions].map((id) =>
          this.market(row.user_id, `/sessions/${id}`, { method: 'DELETE' }),
        ),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }
}
