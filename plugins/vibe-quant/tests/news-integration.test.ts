import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginWebServices } from '@app/plugin-sdk/server';
import { parseConfig } from '../server/config.js';
import { NewsStore } from '../server/news/store.js';
import { NewsWorker } from '../server/news/worker.js';
import { parseFeed } from '../server/news/feed.js';
import { newsSources } from '../server/news/catalog.js';

const enabled = process.env.QUANT_INTEGRATION === '1';
const source = newsSources[0];
const rss = `<rss><channel>${[1, 2, 3].map((id) => `<item><title>Item ${id}</title><link>https://example.org/${id}</link><pubDate>2026-10-22T01:00:00Z</pubDate></item>`).join('')}</channel></rss>`;
async function setup(t: TestContext) {
  const config = parseConfig({
    engine: 'tdx',
    tdxServers: '192.0.2.1:7709',
    clickhouseUrl: 'http://127.0.0.1:18124',
    clickhouseDatabase: 'unused',
    clickhouseUser: 'test',
    clickhousePassword: 'test-only-local',
    maxSubscriptions: 10,
    beforeOpenMinutes: 5,
    afterCloseMinutes: 10,
    flushSeconds: 1,
    pollSeconds: 5,
    historyBars: 100,
    newsDatabase: `news_test_${randomUUID().replaceAll('-', '')}`,
    newsFetchConcurrency: 2,
    newsFailureThreshold: 6,
  });
  const store = new NewsStore(config);
  t.after(() => store.request(`DROP DATABASE \`${config.newsDatabase}\``));
  await store.initialize([source]);
  return { config, store };
}
test(
  'ClickHouse preserves content on rediscovery, keyset pagination, source switches, restart and fenced leases',
  { skip: !enabled },
  async (t) => {
    const { config, store } = await setup(t);
    assert.equal(await store.acquire('writer'), true);
    assert.equal(await store.acquire('other'), false);
    const rows = parseFeed(
      rss,
      source,
      Date.parse('2026-10-22T03:00:00Z') / 1000,
    );
    await store.discover(rows, 'other');
    assert.equal((await store.counts()).total, 0);
    await store.discover(rows, 'writer');
    const article = {
      ...rows[0],
      content: 'Saved body',
      contentStatus: 'ready' as const,
      contentFetchedAt: Date.now() / 1000,
      attempts: 1,
    };
    await store.saveContent(article, 'writer');
    await store.discover(rows, 'writer');
    assert.equal((await store.counts()).total, 3);
    assert.equal((await store.article(article.id))?.content, 'Saved body');
    assert.equal((await store.article(article.id))?.contentStatus, 'ready');
    const first = await store.list({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await store.list({
      limit: 2,
      before: JSON.parse(
        Buffer.from(first.nextCursor!, 'base64url').toString(),
      ),
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
      3,
    );
    assert.equal(
      (await store.list({ q: "' OR 1=1 --", limit: 10 })).items.length,
      0,
    );
    await store.setEnabled(source.id, false);
    assert.equal((await store.pending(10)).length, 0);
    const restarted = new NewsStore(config);
    await restarted.initialize([source]);
    assert.equal((await restarted.sources())[0].enabled, false);
    assert.equal((await restarted.article(article.id))?.content, 'Saved body');
    await store.release('writer');
    await restarted.acquire('new');
    await store.saveContent({ ...article, content: 'stale writer' }, 'writer');
    assert.equal((await store.article(article.id))?.content, 'Saved body');
    await store.release('writer');
    assert.equal((await store.collector()).active, true);
    await restarted.release('new');
  },
);
test(
  'content batches prioritize fresh news without starving the historical queue',
  { skip: !enabled },
  async (t) => {
    const { store } = await setup(t);
    await store.acquire('writer');
    const rows = parseFeed(rss, source, Date.now() / 1000).map(
      (row, index) => ({
        ...row,
        sortAt: index + 1,
        discoveredAt: index + 1,
        nextRetryAt: index + 1,
      }),
    );
    await store.discover(rows, 'writer');
    const batch = await store.pending(2);
    assert.deepEqual(
      batch.map((row) => row.id),
      [rows[2].id, rows[0].id],
    );
    assert.equal((await store.pending(10)).length, 3);
    assert.equal((await store.pending(1))[0].id, rows[0].id);
    await store.saveContent(
      { ...rows[0], contentStatus: 'failed', nextRetryAt: 1.5 },
      'writer',
    );
    assert.equal((await store.pending(2))[1].id, rows[0].id);
  },
);
test(
  'worker persists source errors, retries failed bodies, coordinates instances and cancels immediately',
  { skip: !enabled },
  async (t) => {
    const { config, store } = await setup(t);
    let fetches = 0;
    let fail = true;
    const web: PluginWebServices = {
      request: async (url) => ({
        url,
        status: 200,
        headers: { etag: 'v1' },
        body: new TextEncoder().encode(rss),
      }),
      fetchContent: async (url) => {
        fetches++;
        if (fail) throw new Error('WEB_FETCH_FAILED');
        return {
          url,
          content: '# Full body',
          ok: true,
          provider: 'fixture',
          fallback: false,
        };
      },
    };
    const worker = new NewsWorker(config, store, web);
    await worker.cycle(); // Queue may be read before discovery; the next pass must see it.
    await worker.cycle();
    assert.ok(fetches > 0);
    assert.equal((await store.counts()).failed, 3);
    const savedFetches = fetches;
    const other = new NewsWorker(config, store, web);
    await other.cycle();
    assert.equal(fetches, savedFetches);
    const states = await store.sources();
    assert.equal(states[0].state?.etag, 'v1');
    assert.equal(states[0].state?.error, '');
    // Make the durable retry deadlines due without waiting in the test.
    await store.request(
      `INSERT INTO ${store.table('news_articles')} SELECT * REPLACE (0 AS nextRetryAt, version + 1 AS version) FROM ${store.table('news_articles')} FINAL`,
    );
    fail = false;
    await worker.cycle();
    assert.equal((await store.counts()).ready, 3);
    await worker.stop();
    let started = false;
    await store.request(
      `INSERT INTO ${store.table('news_source_state')} SELECT * REPLACE (0 AS nextPollAt, version + 1 AS version) FROM ${store.table('news_source_state')} FINAL`,
    );
    const blocked = new NewsWorker(config, store, {
      ...web,
      request: async (_url, { signal }) => {
        started = true;
        await delay(60000, undefined, { signal });
        throw new Error('unexpected');
      },
    });
    blocked.start();
    for (let i = 0; i < 100 && !started; i++) await delay(20);
    assert.ok(started);
    const start = Date.now();
    await blocked.stop();
    assert.ok(Date.now() - start < 2000);
    assert.equal((await store.collector()).active, false);
  },
);

test(
  'source CRUD survives restart, enforces URL uniqueness and keeps archived articles after deletion',
  { skip: !enabled },
  async (t) => {
    const { config, store } = await setup(t);
    const input = {
      name: 'Custom source',
      industry: source.industry,
      url: 'https://example.org/custom.xml',
      enabled: true,
    };
    const [a, b] = await Promise.all([
      store.createSource(input),
      store.createSource(input),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const created = (a ?? b)!;
    assert.equal(
      await store.updateSource(created.id, { url: source.url }),
      null,
    );
    const updated = await store.updateSource(created.id, {
      name: 'Edited',
      url: 'https://example.org/edited.xml',
      enabled: false,
    });
    assert.equal(updated?.name, 'Edited');
    assert.equal(updated?.url, 'https://example.org/edited.xml');
    assert.equal(updated?.enabled, false);
    await store.acquire('writer');
    const articles = parseFeed(rss, source);
    await store.discover(articles, 'writer');
    assert.equal(await store.deleteSource(source.id), true);
    assert.equal(await store.deleteSource(source.id), false);
    const restarted = new NewsStore(config);
    await restarted.initialize([source]);
    assert.equal(await restarted.source(source.id), null);
    assert.equal((await restarted.source(created.id))?.name, 'Edited');
    assert.equal((await restarted.counts()).total, 3);
    assert.equal((await restarted.pending(10)).length, 0);
    const restored = await restarted.createSource({
      name: source.name,
      url: source.url,
      industry: source.industry,
      enabled: true,
    });
    assert.equal(restored?.id, source.id);
    assert.equal((await restarted.pending(10)).length, 3);
  },
);

test(
  'concurrent body failures disable a source atomically, retain the cause and resume only on manual enable',
  { skip: !enabled },
  async (t) => {
    const { store } = await setup(t);
    await store.acquire('writer');
    await store.discover(parseFeed(rss, source), 'writer');
    await store.recordSourceResult(
      source.id,
      'WECHAT_VERIFICATION_REQUIRED',
      3,
      'other',
    );
    assert.equal((await store.source(source.id))?.failureCount, 0);
    await store.recordSourceResult(
      source.id,
      'WECHAT_VERIFICATION_REQUIRED',
      3,
      'writer',
    );
    await store.recordSourceResult(source.id, '', 3, 'writer');
    assert.equal((await store.source(source.id))?.failureCount, 0);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.recordSourceResult(
          source.id,
          'WECHAT_VERIFICATION_REQUIRED',
          3,
          'writer',
        ),
      ),
    );
    const paused = (await store.source(source.id))!;
    assert.equal(paused.enabled, false);
    assert.equal(paused.autoDisabled, true);
    assert.equal(paused.failureCount, 3);
    assert.equal(paused.lastError, 'WECHAT_VERIFICATION_REQUIRED');
    assert.equal((await store.pending(10)).length, 0);
    await store.recordSourceResult(source.id, '', 3, 'writer');
    assert.equal(
      (await store.source(source.id))?.lastError,
      'WECHAT_VERIFICATION_REQUIRED',
    );
    const resumed = await store.updateSource(source.id, { enabled: true });
    assert.equal(resumed?.failureCount, 0);
    assert.equal(resumed?.lastError, '');
    assert.equal(resumed?.autoDisabled, false);
    assert.equal((await store.pending(10)).length, 3);
  },
);

test(
  'worker stops dispatch after the threshold and does not store truncated content; feed failures also disable sources',
  { skip: !enabled },
  async (t) => {
    const { config, store } = await setup(t);
    config.newsFailureThreshold = 2;
    config.newsFetchConcurrency = 1;
    let bodyCalls = 0;
    const web: PluginWebServices = {
      request: async (url) => ({
        url,
        status: 200,
        headers: {},
        body: new TextEncoder().encode(rss),
      }),
      fetchContent: async (url) => {
        bodyCalls++;
        return {
          url,
          content: 'Partial',
          truncated: true,
          ok: true,
          provider: 'fixture',
          fallback: false,
        };
      },
    };
    const worker = new NewsWorker(config, store, web);
    await worker.cycle();
    await worker.cycle();
    assert.equal(bodyCalls, 2);
    assert.equal(
      (await store.source(source.id))?.lastError,
      'ARTICLE_INCOMPLETE',
    );
    assert.equal((await store.source(source.id))?.enabled, false);
    assert.equal(
      (
        await store.rows<{ total: number }>(
          `SELECT count() AS total FROM ${store.table('news_contents')} FINAL`,
        )
      )[0].total,
      0,
    );
    await worker.stop();
    await store.updateSource(source.id, { enabled: true });
    const failedFeed = new NewsWorker(config, store, {
      ...web,
      request: async (url) => ({
        url,
        status: 403,
        headers: {},
        body: new Uint8Array(),
      }),
    });
    await failedFeed.cycle();
    await store.request(
      `INSERT INTO ${store.table('news_source_state')} SELECT * REPLACE (0 AS nextPollAt, version + 1 AS version) FROM ${store.table('news_source_state')} FINAL`,
    );
    await failedFeed.cycle();
    assert.equal(
      (await store.source(source.id))?.lastError,
      'RSS_FEED_HTTP_403',
    );
    assert.equal((await store.source(source.id))?.enabled, false);
    await failedFeed.stop();
  },
);

test(
  'Playwright rendered WeChat body passes through the worker and round-trips in ClickHouse without truncation',
  {
    skip: !enabled || process.env.TEST_WEB_FETCH_BROWSER !== '1',
    timeout: 30000,
  },
  async (t) => {
    const { store, config } = await setup(t);
    const { readArticleContent } =
      await import('../../../apps/server/src/mastra/web/article.js');
    const { readBrowserPage } =
      await import('../../../apps/server/src/mastra/web/page.js');
    const url = 'https://mp.weixin.qq.com/s/rendered-test';
    const paragraph = '完整中文段落，保留每一行和最后一段。'.repeat(4000);
    const html = `<html><head><meta charset="utf-8"><title>完整正文测试</title></head><body><div id="js_content"><p>${paragraph}</p><p>最终完整段落</p></div></body></html>`;
    const feed = `<rss><channel><item><title>完整正文测试</title><link>${url}</link><pubDate>2026-10-22T01:00:00Z</pubDate></item></channel></rss>`;
    let extracted = '';
    const worker = new NewsWorker(config, store, {
      request: async (feedUrl) => ({
        url: feedUrl,
        status: 200,
        headers: {},
        body: new TextEncoder().encode(feed),
      }),
      fetchContent: async (target, signal) => {
        const result = await readArticleContent(target, signal, {
          browser: (pageUrl, pageSignal, timeout) =>
            readBrowserPage(pageUrl, pageSignal, timeout, async () => ({
              url: pageUrl,
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: Buffer.from(html),
            })),
          direct: async () => {
            throw new Error('Browser must succeed');
          },
        });
        extracted = result.content;
        return result;
      },
    });
    await worker.cycle();
    await worker.cycle();
    const [row] = (await store.list({ limit: 1 })).items;
    const saved = (await store.article(row.id))!;
    assert.equal(saved.contentStatus, 'ready');
    assert.equal(saved.contentProvider, 'playwright');
    assert.equal(saved.contentTruncated, false);
    assert.equal(saved.content.length, extracted.length);
    assert.ok(saved.content.length > 50_000);
    assert.ok(saved.content === extracted && saved.content.includes(paragraph));
    assert.equal(saved.content.slice(-6), '最终完整段落');
    await store.requeueArticles([saved.id]);
    assert.equal((await store.article(saved.id))?.contentStatus, 'pending');
    assert.equal((await store.counts()).ready, 0);
    await worker.stop();
  },
);

test(
  'existing source table migrates in place without resetting disabled sources',
  { skip: !enabled },
  async (t) => {
    const { store } = await setup(t);
    await store.request(`DROP TABLE ${store.table('news_sources')}`);
    await store.request(
      `CREATE TABLE ${store.table('news_sources')} (id String, name String, industry String, url String, enabled Bool, version UInt64) ENGINE = ReplacingMergeTree(version) ORDER BY id`,
    );
    await store.request(
      `INSERT INTO ${store.table('news_sources')} FORMAT JSONEachRow`,
      {},
      JSON.stringify({
        id: source.id,
        name: source.name,
        industry: source.industry,
        url: source.url,
        enabled: false,
        version: 1,
      }),
    );
    await store.initialize([source]);
    const migrated = (await store.sources())[0];
    assert.equal(migrated.enabled, false);
    assert.equal(migrated.failureCount, 0);
    assert.equal(migrated.lastError, '');
    assert.equal(migrated.autoDisabled, false);
    await store.updateSource(source.id, { enabled: true });
    assert.equal((await store.source(source.id))?.enabled, true);
  },
);

test(
  'RSS bodies go straight to ClickHouse; summary-only entries are absent and source mode persists across edits and restart',
  { skip: !enabled },
  async (t) => {
    const { store, config } = await setup(t);
    await store.setEnabled(source.id, false);
    const feedSource = (await store.createSource({
      name: 'Full feed',
      industry: 'ai',
      url: 'https://example.org/full.xml',
      enabled: true,
      contentMode: 'feed',
    }))!;
    await store.updateSource(feedSource.id, { name: 'Full feed edited' });
    await store.setEnabled(feedSource.id, false);
    await store.setEnabled(feedSource.id, true);
    assert.equal((await store.source(feedSource.id))?.contentMode, 'feed');
    const fullBody = '完整文章段落，不能截断。'.repeat(5000);
    const full = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Saved</title><link>https://example.org/article</link><pubDate>2026-10-22T01:00:00Z</pubDate><content:encoded><![CDATA[<p>${fullBody}</p><p>最终完整段落</p>]]></content:encoded></item><item><title>Skipped</title><link>https://example.org/summary</link><description>Only summary</description></item></channel></rss>`;
    let pageCalls = 0;
    const worker = new NewsWorker(config, store, {
      request: async (url) => ({
        url,
        status: 200,
        headers: {},
        body: new TextEncoder().encode(full),
      }),
      fetchContent: async () => {
        pageCalls++;
        throw new Error('No page calls allowed');
      },
    });
    await worker.cycle();
    const [summary] = (await store.list({ source: feedSource.id, limit: 10 }))
      .items;
    const saved = (await store.article(summary.id))!;
    assert.equal(saved.contentStatus, 'ready');
    assert.equal(saved.contentProvider, 'rss');
    assert.ok(saved.content.length > 50000 && saved.content.includes(fullBody));
    assert.equal(saved.content.slice(-6), '最终完整段落');
    assert.equal((await store.counts()).total, 1);
    assert.equal((await store.pending(10)).length, 0);
    assert.equal(pageCalls, 0);
    await store.request(
      `INSERT INTO ${store.table('news_source_state')} SELECT * REPLACE (0 AS nextPollAt, version + 1 AS version) FROM ${store.table('news_source_state')} FINAL`,
    );
    await worker.cycle();
    assert.equal((await store.counts()).total, 1);
    assert.equal((await store.article(summary.id))?.content, saved.content);
    const restarted = new NewsStore(config);
    await restarted.initialize([source]);
    assert.equal((await restarted.source(feedSource.id))?.contentMode, 'feed');
    await worker.stop();
  },
);
