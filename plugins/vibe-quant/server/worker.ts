import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { QueryRunner } from 'typeorm';
import type { PluginContext } from '@app/plugin-sdk/server';
import type {
  Bar,
  Instrument,
  OrderBook,
  Quote,
  SyncStatus,
} from '../shared.js';
import type { QuantConfig } from './config.js';
import { MarketStore } from './clickhouse.js';
import { ensurePython } from './python.js';

type Event =
  | { type: 'catalog'; instruments: Instrument[] }
  | { type: 'catalog_complete'; symbols: string[] }
  | { type: 'data'; quotes: Quote[]; bars: Bar[]; orderBooks?: OrderBook[] }
  | {
      type: 'status';
      state: SyncStatus['state'];
      message: string;
      active: number;
    };
const LOCK = 179210001;

export class SyncWorker {
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
  constructor(
    private readonly context: PluginContext,
    readonly config: QuantConfig,
    readonly store: MarketStore,
    private readonly preparePython = (signal: AbortSignal) =>
      ensurePython(context.runtime, signal),
  ) {
    this.status = {
      engine: config.engine,
      state: 'starting',
      message: '正在连接行情引擎',
      updatedAt: null,
      lastWriteAt: null,
      subscriptions: 0,
      active: 0,
      catalogCount: 0,
      beforeOpenMinutes: config.beforeOpenMinutes,
      afterCloseMinutes: config.afterCloseMinutes,
    };
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
              (event.orderBooks?.length ?? 0);
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
    await this.context.database.query(
      `INSERT INTO plugin_vibe_quant_status (id, payload) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [JSON.stringify(this.status)],
    );
  }
  private async prepare(signal: AbortSignal, runner: QueryRunner) {
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
      heartbeat = runner
        .query('SELECT 1')
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
    for (const event of batch) {
      if (event.type === 'catalog') {
        await this.context.database.query(
          `INSERT INTO plugin_vibe_quant_instruments (engine, symbol, metadata)
          SELECT $1, item->>'symbol', item FROM jsonb_array_elements($2::jsonb) item
          ON CONFLICT (engine, symbol) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = now()`,
          [this.config.engine, JSON.stringify(event.instruments)],
        );
      } else if (event.type === 'catalog_complete') {
        await this.context.database.query(
          `UPDATE plugin_vibe_quant_instruments SET metadata = jsonb_set(metadata, '{expired}', 'true')
          WHERE engine = $1 AND NOT (symbol = ANY($2::text[]))`,
          [this.config.engine, event.symbols],
        );
      } else if (event.type === 'data') {
        quotes.push(...event.quotes);
        orderBooks.push(...(event.orderBooks ?? []));
        for (const bar of event.bars)
          bars.set(`${bar.symbol}:${bar.duration}:${bar.time}`, bar);
      }
    }
    await this.store.write(
      this.config.engine,
      quotes,
      [...bars.values()],
      orderBooks,
    );
    if (quotes.length || bars.size || orderBooks.length)
      this.status.lastWriteAt = new Date().toISOString();
    this.pending.splice(0, count);
    this.pendingRows = this.pending.reduce(
      (total, event) =>
        total +
        (event.type === 'catalog'
          ? event.instruments.length
          : event.type === 'data'
            ? event.quotes.length +
              event.bars.length +
              (event.orderBooks?.length ?? 0)
            : 0),
      0,
    );
    if (this.pendingRows < 50_000) this.child?.stdout.resume();
  }
  private async run(signal: AbortSignal) {
    let runner: QueryRunner | undefined;
    let leader = false;
    try {
      while (!signal.aborted) {
        try {
          await this.context.assertEnabled();
          if (!runner) {
            runner = this.context.database.createQueryRunner();
            await runner.connect();
          }
          if (!leader)
            leader = (
              await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [
                LOCK,
              ])
            )[0].locked;
          if (leader) {
            // Probe the same session before each iteration. Losing it must stop the old producer.
            await runner.query('SELECT 1');
            if (!this.pythonPath) await this.prepare(signal, runner);
            await this.flush();
            const rows: { symbol: string }[] =
              await this.context.database.query(
                `SELECT DISTINCT w.symbol FROM plugin_vibe_quant_watchlist w
              JOIN plugin_vibe_quant_instruments i ON i.symbol = w.symbol AND i.engine = $1
              WHERE w.enabled AND NOT COALESCE((i.metadata->>'expired')::boolean, false) ORDER BY w.symbol LIMIT $2`,
                [this.config.engine, this.config.maxSubscriptions],
              );
            const symbols = rows.map((row) => row.symbol);
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
            const [{ count }] = await this.context.database.query(
              'SELECT count(*)::int AS count FROM plugin_vibe_quant_instruments WHERE engine = $1',
              [this.config.engine],
            );
            this.status.catalogCount = count;
            this.status.updatedAt = new Date().toISOString();
            await this.context.database.query(
              `INSERT INTO plugin_vibe_quant_status (id, payload) VALUES (1, $1::jsonb)
              ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
              [JSON.stringify(this.status)],
            );
          }
        } catch {
          this.status.state = 'error';
          this.status.message = this.pythonPath
            ? '同步或写入失败，保留待写批次并重试'
            : 'Python 环境准备失败，请检查宿主 Python 3.9+、venv 及依赖下载网络；30 秒后重试';
          if (leader) {
            try {
              this.status.updatedAt = new Date().toISOString();
              await this.context.database.query(
                `INSERT INTO plugin_vibe_quant_status (id, payload) VALUES (1, $1::jsonb)
                ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
                [JSON.stringify(this.status)],
              );
            } catch {
              /* Database outage is shown as a stale heartbeat by readers. */
            }
          }
          // Never continue producing after a lock/database failure.
          await this.stopChild();
          if (runner) {
            try {
              if (leader)
                await runner.query('SELECT pg_advisory_unlock($1)', [LOCK]);
            } catch {
              /* Connection may already have been lost. */
            }
            try {
              await runner.release();
            } catch {
              /* A broken pool client is already released. */
            }
          }
          runner = undefined;
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
      if (runner) {
        try {
          if (leader)
            await runner.query('SELECT pg_advisory_unlock($1)', [LOCK]);
        } finally {
          await runner.release();
        }
      }
    }
  }
}
