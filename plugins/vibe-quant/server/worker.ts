import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { PluginContext } from '@app/plugin-sdk/server';
import type {
  Bar,
  Instrument,
  OrderBook,
  Quote,
  SyncStatus,
  Tick,
} from '../shared.js';
import type { QuantConfig } from './config.js';
import { MarketStore } from './clickhouse.js';
import { StateStore } from './state-store.js';
import { ensurePython } from './python.js';

type Event =
  | { type: 'catalog'; instruments: Instrument[] }
  | { type: 'catalog_complete'; symbols: string[] }
  | {
      type: 'data';
      quotes: Quote[];
      bars: Bar[];
      orderBooks?: OrderBook[];
      ticks?: Tick[];
    }
  | {
      type: 'status';
      state: SyncStatus['state'];
      message: string;
      active: number;
    };

export class SyncWorker {
  private readonly instanceId = randomUUID();
  private controller?: AbortController;
  private task?: Promise<void>;
  private child?: ChildProcessWithoutNullStreams;
  private pending: Event[] = [];
  private pendingRows = 0;
  private fingerprint = '';
  private restartAfter = 0;
  private lastOutputAt = 0;
  private pythonPath?: string;
  private status: SyncStatus;
  private tickChecks = new Map<
    string,
    { tradingDay: string; nextCheck: number }
  >();
  constructor(
    private readonly context: PluginContext,
    readonly config: QuantConfig,
    readonly store: MarketStore,
    readonly state: StateStore,
    private readonly preparePython = (signal: AbortSignal) =>
      ensurePython(context.runtime, signal),
  ) {
    this.status = {
      engine: config.engine,
      state: 'starting',
      message: '正在连接行情引擎',
      updatedAt: null,
      lastWriteAt: null,
      lastReceivedAt: null,
      clickhouseReadOnly: config.clickhouseReadOnly,
      subscriptions: 0,
      active: 0,
      catalogCount: 0,
      beforeOpenMinutes: config.beforeOpenMinutes,
      afterCloseMinutes: config.afterCloseMinutes,
    };
  }
  getStatus(): SyncStatus {
    return { ...this.status };
  }
  start() {
    this.controller = new AbortController();
    this.task = this.run(this.controller.signal).catch(() => {
      this.status.state = 'error';
      this.status.message = '同步进程退出，请重新启用插件';
    });
  }
  async stop() {
    this.controller?.abort();
    await this.stopChild();
    await this.task;
    this.task = undefined;
  }
  private async stopChild() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdout.resume();
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    );
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await closed;
    clearTimeout(timer);
  }
  private launch(symbols: string[]) {
    const worker = resolve(
      this.context.runtime.paths.pluginRoot,
      'worker/main.py',
    );
    if (!this.pythonPath) throw new Error('PYTHON_NOT_READY');
    const child = spawn(this.pythonPath, ['-u', worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.child = child;
    this.lastOutputAt = Date.now();
    const catalogSymbols = new Set<string>();
    this.status.state = 'starting';
    this.status.message = '正在连接行情引擎并加载合约目录';
    // Credentials are delivered over stdin, never command-line arguments or application logs.
    const config = { ...this.config, clickhousePassword: undefined };
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...config, symbols }) + '\n');
    child.stderr.resume(); // SDK logs may contain credentials; status events provide sanitized failures.
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      this.lastOutputAt = Date.now();
      try {
        const event = JSON.parse(line) as Event;
        if (event.type === 'catalog_complete') {
          this.pending.push({
            type: 'catalog_complete',
            symbols: [...catalogSymbols],
          });
          return;
        }
        if (event.type === 'status') {
          this.status = {
            ...this.status,
            state: event.state,
            message: event.message.slice(0, 500),
            active: event.active,
          };
          return;
        }
        if (event.type !== 'catalog' && event.type !== 'data') return;
        if (event.type === 'catalog')
          for (const item of event.instruments) catalogSymbols.add(item.symbol);
        const count =
          event.type === 'catalog'
            ? event.instruments.length
            : event.quotes.length +
              event.bars.length +
              (event.orderBooks?.length ?? 0) +
              (event.ticks?.length ?? 0);
        this.pending.push(event);
        this.pendingRows += count;
        // Backpressure bounds memory while retaining the queued batch for retries.
        if (this.pendingRows >= 50_000) child.stdout.pause();
      } catch {
        this.status.state = 'error';
        this.status.message = '行情进程输出格式错误';
      }
    });
    child.on('error', () => {
      this.status.state = 'error';
      this.status.message = '无法启动 Python，请检查可执行路径与依赖';
    });
    child.on('close', () => {
      lines.close();
      if (this.child !== child) return;
      this.child = undefined;
      this.restartAfter = Date.now() + 30_000;
      this.status.state = 'error';
      if (
        !this.status.message.includes('失败') &&
        !this.status.message.includes('权限')
      )
        this.status.message =
          '行情进程已退出，30 秒后重连；请检查引擎参数与 Python 依赖';
    });
  }
  private async saveStatus() {
    this.status.updatedAt = new Date().toISOString();
    await this.state.saveStatus(this.instanceId, this.status);
  }
  private async renewLease() {
    if (
      !this.config.clickhouseReadOnly &&
      !(await this.state.acquireLease(this.config.engine, this.instanceId))
    )
      throw new Error('WRITER_LEASE_LOST');
  }
  private async prepare(signal: AbortSignal) {
    this.status.state = 'starting';
    this.status.message =
      '正在准备插件专属 Python 环境，首次安装可能需要几分钟';
    await this.saveStatus();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = this.renewLease()
        .then(() => this.saveStatus())
        .catch(abort)
        .finally(() => {
          heartbeat = undefined;
        });
    }, 5000);
    try {
      this.pythonPath = await this.preparePython(controller.signal);
      controller.signal.throwIfAborted();
    } finally {
      clearInterval(timer);
      await heartbeat;
      signal.removeEventListener('abort', abort);
    }
  }
  private async flush() {
    const count = this.pending.length;
    if (!count) return;
    const batch = this.pending.slice(0, count);
    const quotes: Quote[] = [];
    const orderBooks: OrderBook[] = [];
    const bars = new Map<string, Bar>();
    const ticks = new Map<string, Tick>();
    for (const event of batch) {
      if (event.type === 'catalog') {
        await this.state.saveCatalog(this.config.engine, event.instruments);
      } else if (event.type === 'catalog_complete') {
        await this.state.completeCatalog(this.config.engine, event.symbols);
      } else if (event.type === 'data') {
        quotes.push(...event.quotes);
        orderBooks.push(...(event.orderBooks ?? []));
        for (const bar of event.bars)
          bars.set(`${bar.symbol}:${bar.duration}:${bar.time}`, bar);
        for (const tick of event.ticks ?? [])
          ticks.set(
            `${tick.symbol}:${tick.tradingDay}:${tick.timeNs}:${tick.tickId}`,
            tick,
          );
      }
    }
    await this.store.write(
      this.config.engine,
      quotes,
      [...bars.values()],
      orderBooks,
      this.instanceId,
      [...ticks.values()],
    );
    if (!this.config.clickhouseReadOnly) {
      for (const tick of ticks.values()) {
        const previous = this.tickChecks.get(tick.symbol);
        if (!previous || tick.tradingDay > previous.tradingDay)
          this.tickChecks.set(tick.symbol, {
            tradingDay: tick.tradingDay,
            nextCheck: 0,
          });
      }
      // Retain only bounded latest-contract diagnostics across watchlist changes.
      while (this.tickChecks.size > this.config.maxSubscriptions * 2)
        this.tickChecks.delete(this.tickChecks.keys().next().value!);
    }
    if (quotes.length || bars.size || orderBooks.length || ticks.size) {
      this.status.lastReceivedAt = new Date().toISOString();
      if (!this.config.clickhouseReadOnly)
        this.status.lastWriteAt = this.status.lastReceivedAt;
    }
    this.pending.splice(0, count);
    this.pendingRows = this.pending.reduce(
      (total, event) =>
        total +
        (event.type === 'catalog'
          ? event.instruments.length
          : event.type === 'data'
            ? event.quotes.length +
              event.bars.length +
              (event.orderBooks?.length ?? 0) +
              (event.ticks?.length ?? 0)
            : 0),
      0,
    );
    if (this.pendingRows < 50_000) this.child?.stdout.resume();
  }
  private async checkTickVolumes() {
    if (this.config.clickhouseReadOnly || this.config.engine !== 'tqsdk')
      return;
    // One symbol per processing cycle keeps large watchlists from blocking ingestion.
    const entry = [...this.tickChecks].find(
      ([, check]) => check.nextCheck <= Date.now(),
    );
    if (!entry) return;
    const [symbol, check] = entry;
    check.nextCheck = Date.now() + 60_000;
    // Move it to the tail so a slow validation cannot starve later symbols.
    this.tickChecks.delete(symbol);
    this.tickChecks.set(symbol, check);
    try {
      const result = await this.store.validateTickVolumes(
        this.config.engine,
        symbol,
        check.tradingDay,
      );
      this.status.tickValidation = [
        ...(this.status.tickValidation ?? []).filter(
          (item) => item.symbol !== symbol && this.tickChecks.has(item.symbol),
        ),
        result,
      ];
      this.status.tickValidationError = null;
    } catch {
      // Data is already committed; a diagnostic failure must not replay/restart collection.
      this.status.tickValidationError = 'Tick 成交量校验暂不可用，稍后重试';
    }
  }
  private async run(signal: AbortSignal) {
    let leader = false;
    try {
      while (!signal.aborted) {
        try {
          await this.context.assertEnabled();
          leader =
            this.config.clickhouseReadOnly ||
            (await this.state.acquireLease(
              this.config.engine,
              this.instanceId,
            ));
          if (leader) {
            if (!this.pythonPath) await this.prepare(signal);
            await this.flush();
            await this.checkTickVolumes();
            const symbols = await this.state.subscriptions(this.config.engine);
            if (symbols.length > this.config.maxSubscriptions)
              throw new Error('SUBSCRIPTION_LIMIT');
            if (this.config.clickhouseReadOnly)
              this.store.retainSymbols(this.config.engine, symbols);
            const tradingDate = new Date().toLocaleDateString('sv-SE', {
              timeZone: 'Asia/Shanghai',
            });
            const fingerprint = JSON.stringify([tradingDate, symbols]);
            if (fingerprint !== this.fingerprint) {
              await this.stopChild();
              this.fingerprint = fingerprint;
              this.restartAfter = 0;
            }
            if (
              this.child &&
              Date.now() - this.lastOutputAt > 180_000 &&
              this.pendingRows < 50_000
            ) {
              await this.stopChild();
              this.status.state = 'error';
              this.status.message = '行情进程心跳超时，正在重连';
            }
            if (
              !signal.aborted &&
              !this.child &&
              Date.now() >= this.restartAfter
            )
              this.launch(symbols);
            this.status.subscriptions = symbols.length;
            this.status.catalogCount = await this.state.catalogCount(
              this.config.engine,
            );
            await this.saveStatus();
          } else {
            await this.stopChild();
            this.status.state = 'standby';
            this.status.message = '共享 ClickHouse 的另一服务正在写入行情';
            this.status.active = 0;
            await this.saveStatus();
          }
        } catch {
          this.status.state = 'error';
          this.status.message = this.pythonPath
            ? '行情处理失败，保留待处理批次并重试'
            : 'Python 环境准备失败，请检查宿主 Python 3.9+、venv 及依赖下载网络；30 秒后重试';
          if (leader) {
            try {
              await this.saveStatus();
            } catch {
              /* Database outage is shown as a stale heartbeat by readers. */
            }
          }
          await this.stopChild();
          if (leader && !this.config.clickhouseReadOnly) {
            await this.state
              .releaseLease(this.config.engine, this.instanceId)
              .catch(() => {});
          }
          leader = false;
          if (!this.pythonPath)
            await delay(30_000, undefined, { signal }).catch(() => {});
        }
        await delay(this.config.flushSeconds * 1000, undefined, {
          signal,
        }).catch(() => {});
      }
    } finally {
      await this.stopChild();
      try {
        await this.flush();
      } catch {
        /* Last uncommitted updates are recovered by bounded history on restart. */
      }
      if (leader && !this.config.clickhouseReadOnly)
        await this.state
          .releaseLease(this.config.engine, this.instanceId)
          .catch(() => {});
    }
  }
}
