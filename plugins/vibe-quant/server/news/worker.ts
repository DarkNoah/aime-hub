import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginWebServices } from '@app/plugin-sdk/server';
import type { QuantConfig } from '../config.js';
import type { NewsStore } from './store.js';
import { articleUrl, fetchFeed } from './feed.js';

async function pooled<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  run: (item: T) => Promise<void>,
) {
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!signal.aborted && next < items.length) await run(items[next++]);
    }),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
const errorCode = (error: unknown) =>
  error instanceof Error && /^[A-Z_]+(?:_\d+)?$/.test(error.message)
    ? error.message
    : 'FETCH_FAILED';
export class NewsWorker {
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private task?: Promise<void>;
  private stopped = true;
  constructor(
    private readonly config: QuantConfig,
    private readonly store: NewsStore,
    private readonly web: PluginWebServices,
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.task = this.cycle(true)
        .catch((error) => {
          if (!this.stopped)
            console.warn('[quant-news] collection failed', errorCode(error));
        })
        .finally(() => this.schedule(5000));
    }, ms);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller?.abort(new Error('用户中止了操作'));
    await this.task;
    await this.store.release(this.owner);
  }
  /** One bounded polling pass; persistent queues also survive service restarts. */
  async cycle(continuous = false) {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    if (!(await this.store.acquire(this.owner)) || signal.aborted) return;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal || signal.aborted) return;
      renewal = this.store
        .acquire(this.owner)
        .then((held) => {
          if (!held) controller.abort(new Error('NEWS_LEASE_LOST'));
        })
        .catch(() => controller.abort(new Error('NEWS_LEASE_LOST')))
        .finally(() => {
          renewal = undefined;
        });
    }, 20_000);
    heartbeat.unref();
    const repeat = async (operation: () => Promise<void>) => {
      do {
        signal.throwIfAborted();
        await operation();
        if (continuous) await delay(5000, undefined, { signal });
      } while (continuous && !signal.aborted);
    };
    // Independent loops: slow feeds never hold up the durable body queue.
    const tasks = [
      repeat(() => this.pollFeeds(signal)),
      repeat(() => this.fetchContents(signal)),
    ];
    try {
      await Promise.all(tasks);
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      await Promise.allSettled(tasks);
      await renewal;
    }
  }
  private async pollFeeds(signal: AbortSignal) {
    const sources = (await this.store.sources()).filter(
      (source) =>
        source.enabled &&
        (!source.state || source.state.nextPollAt <= Date.now() / 1000),
    );
    await pooled(sources, 6, signal, async (source) => {
      if (!(await this.store.source(source.id))?.enabled) return;
      const previous = source.state;
      const state = {
        sourceId: source.id,
        lastPollAt: Date.now() / 1000,
        lastSuccessAt: previous?.lastSuccessAt ?? 0,
        nextPollAt: 0,
        failures: 0,
        error: '',
        etag: previous?.etag ?? '',
        lastModified: previous?.lastModified ?? '',
        itemCount: previous?.itemCount ?? 0,
      };
      try {
        const result = await fetchFeed(this.web, source, previous, signal);
        signal.throwIfAborted();
        if (result.items) await this.store.discover(result.items, this.owner);
        state.lastSuccessAt = Date.now() / 1000;
        state.nextPollAt = state.lastSuccessAt + this.config.newsPollSeconds;
        state.etag = result.etag;
        state.lastModified = result.lastModified;
        state.itemCount = result.items?.length ?? state.itemCount;
      } catch (error) {
        if (signal.aborted) return;
        state.failures = (previous?.failures ?? 0) + 1;
        state.error = errorCode(error);
        state.nextPollAt =
          Date.now() / 1000 +
          Math.min(
            3600,
            this.config.newsPollSeconds * 2 ** Math.min(state.failures - 1, 8),
          );
      }
      if (!signal.aborted) await this.store.saveSource(state, this.owner);
      if (!signal.aborted && state.failures >= this.config.newsFailureThreshold)
        await this.store.recordSourceResult(
          source.id,
          `RSS_${state.error}`,
          this.config.newsFailureThreshold,
          this.owner,
          true,
        );
    });
  }
  private async fetchContents(signal: AbortSignal) {
    const items = await this.store.pending(
      this.config.newsFetchConcurrency * 4,
    );
    await pooled(
      items,
      this.config.newsFetchConcurrency,
      signal,
      async (article) => {
        const source = await this.store.source(article.sourceId);
        if (!source?.enabled || source.contentMode === 'feed') return;
        try {
          const result = await this.web.fetchContent(
            article.url,
            AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
          );
          signal.throwIfAborted();
          if (!result.ok || !result.content.trim())
            throw new Error('WEB_FETCH_FAILED');
          if (result.truncated) throw new Error('ARTICLE_INCOMPLETE');
          article.content = result.content;
          article.contentStatus = 'ready';
          article.contentFetchedAt = Date.now() / 1000;
          article.contentUrl = articleUrl(result.url) ?? article.url;
          article.contentProvider = result.provider;
          article.contentTruncated = false;
          article.contentError = '';
          article.nextRetryAt = 0;
        } catch (error) {
          if (signal.aborted) return;
          article.contentStatus = 'failed';
          article.contentError = errorCode(error);
          article.nextRetryAt =
            Date.now() / 1000 +
            Math.min(3600, 30 * 2 ** Math.min(article.attempts, 8));
        }
        article.attempts++;
        if (!signal.aborted) {
          await this.store.saveContent(article, this.owner);
          await this.store.recordSourceResult(
            article.sourceId,
            article.contentError,
            this.config.newsFailureThreshold,
            this.owner,
          );
        }
      },
    );
  }
}
