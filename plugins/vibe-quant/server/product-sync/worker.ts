import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ProductSyncResult,
  ProductSyncTarget,
} from '../../product-sync-types.js';
import type { Bar } from '../../shared.js';
import type { MarketStore } from '../clickhouse.js';
import type { QuantConfig } from '../config.js';
import type { ProductSyncStore } from './store.js';

type ArchiveEvent =
  { type: 'bars'; bars: Bar[] } | { type: 'result'; result: ProductSyncResult };

async function* readArchive(
  python: string,
  script: string,
  config: QuantConfig,
  targets: ProductSyncTarget[],
  signal: AbortSignal,
): AsyncGenerator<ArchiveEvent> {
  signal.throwIfAborted();
  const child = spawn(python, ['-B', '-u', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<number | null>((resolve) => {
    // Node emits close after error even when the executable does not exist.
    child.on('error', () => {});
    child.once('close', resolve);
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1500);
  };
  signal.addEventListener('abort', stop, { once: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    // Provider diagnostics may contain credentials; outcomes use fixed codes.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        tqUser: config.tqUser,
        tqPassword: config.tqPassword,
        historyBars: config.historyBars,
        targets,
      }) + '\n',
    );
    for await (const line of lines) {
      signal.throwIfAborted();
      yield JSON.parse(line) as ArchiveEvent;
    }
    if ((await closed) !== 0) throw new Error('ARCHIVE_PROVIDER_FAILED');
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', stop);
    lines.close();
    stop();
    await closed;
    clearTimeout(killTimer);
  }
}

/** Runs only on the existing market writer. Each short-lived Tq session releases
 * its chart subscriptions before loading the next batch of contracts. */
export class ProductArchiveWorker {
  private controller?: AbortController;
  private task?: Promise<void>;

  constructor(
    private readonly config: QuantConfig,
    private readonly script: string,
    private readonly market: Pick<MarketStore, 'write'>,
    private readonly products: Pick<ProductSyncStore, 'due' | 'record'>,
    private readonly ownerId: string,
  ) {}

  start(python: string) {
    if (
      this.task ||
      this.config.clickhouseReadOnly ||
      this.config.engine !== 'tqsdk'
    )
      return;
    this.controller = new AbortController();
    this.task = this.run(python, this.controller.signal);
  }

  async stop() {
    this.controller?.abort();
    await this.task;
    this.task = undefined;
  }

  private async run(python: string, signal: AbortSignal) {
    // Limit both the number of chart handles and memory for large history windows.
    const limit = Math.min(
      12,
      Math.max(1, Math.floor(64000 / (6 * this.config.historyBars))),
    );
    while (!signal.aborted) {
      let wait = 15000;
      try {
        const targets = await this.products.due(this.config.engine, limit);
        signal.throwIfAborted();
        if (targets.length) {
          await this.collect(python, targets, signal);
          wait = 1000;
        }
      } catch {
        // A database outage or lease change leaves unfinished work eligible.
      }
      await delay(wait, undefined, { signal }).catch(() => {});
    }
  }

  private async collect(
    python: string,
    targets: ProductSyncTarget[],
    signal: AbortSignal,
  ) {
    const results = new Map<string, ProductSyncResult>();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
    try {
      for await (const event of readArchive(
        python,
        this.script,
        this.config,
        targets,
        timeout,
      )) {
        if (event.type === 'bars') {
          await this.market.write(
            this.config.engine,
            [],
            event.bars,
            [],
            this.ownerId,
          );
        } else if (event.type === 'result') {
          results.set(event.result.symbol, event.result);
        }
      }
    } catch {
      // Result messages follow the corresponding writes. On timeout or a
      // partial write, an unfinished contract is retried from its old cursor.
    }
    signal.throwIfAborted();
    await this.products.record(
      this.config.engine,
      this.ownerId,
      targets.map(
        (target) =>
          results.get(target.symbol) ?? {
            ...target,
            firstBarAt: 0,
            lastBarAt: 0,
            outcome: 'error',
          },
      ),
    );
  }
}
