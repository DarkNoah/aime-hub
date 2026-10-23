import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginHttpEnv, PluginWebServices } from '@app/plugin-sdk/server';
import { articleUrl, fetchFeed, parseFeed } from '../server/news/feed.js';
import { newsIndustries, newsSources } from '../server/news/catalog.js';
import { newsRoutes } from '../server/news/routes.js';
import type { NewsStore } from '../server/news/store.js';
import type { QuantConfig } from '../server/config.js';
import type { NewsSourceState } from '../news-types.js';

export const source = newsSources[0];
export const rss = `<rss version="2.0"><channel><item><title><![CDATA[AI &amp; research]]></title><link>https://example.org/article?p=1&amp;utm_source=rss</link><pubDate>Thu, 22 Oct 2026 09:00:00 +0800</pubDate><description><![CDATA[<p>New <b>results</b><script>bad()</script></p>]]></description></item><item><title>Second</title><link>https://example.org/article?p=2</link><pubDate>invalid</pubDate></item></channel></rss>`;
export const now = Date.parse('2026-10-22T03:00:00Z') / 1000;
test('catalog imports the current 106 sources and 12 industries with stable unique IDs', () => {
  assert.equal(newsSources.length, 106);
  assert.equal(newsIndustries.length, 12);
  assert.equal(new Set(newsSources.map((source) => source.id)).size, 106);
  assert.ok(
    newsSources.every((source) =>
      newsIndustries.some((industry) => source.industry === industry.key),
    ),
  );
});
test('RSS keeps source identity, separates discovery from publication and strips summary markup', () => {
  const rows = parseFeed(rss, source, now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'AI & research');
  assert.equal(rows[0].summary, 'New results');
  assert.equal(rows[0].publishedAt, Date.parse('2026-10-22T01:00:00Z') / 1000);
  assert.equal(rows[1].publishedAt, null);
  assert.equal(rows[1].sortAt, now);
  assert.equal(rows[0].content, '');
  assert.equal(rows[0].contentStatus, 'pending');
  assert.equal(rows[0].nextRetryAt, 0);
  assert.equal(rows[0].sourceName, source.name);
  assert.equal(rows[0].discoveredAt, now);
  assert.notEqual(rows[0].id, rows[1].id);
});
test('Atom selects alternate URLs, relative links and namespaced RDF dates', () => {
  const [atom] = parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom</title><link rel="self" href="/entry.atom"/><link rel="alternate" href="/story"/><updated>2026-10-22T00:00:00Z</updated><summary type="html">&lt;p&gt;Summary&lt;/p&gt;</summary></entry></feed>`,
    source,
    now,
    'https://example.org/feed',
  );
  assert.equal(atom.url, 'https://example.org/story');
  assert.equal(atom.summary, 'Summary');
  const [rdf] = parseFeed(
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><item><title>RDF</title><link>https://example.org/rdf</link><dc:date>2026-10-21T12:00:00Z</dc:date></item></rdf:RDF>`,
    source,
    now,
  );
  assert.equal(rdf.publishedAt, Date.parse('2026-10-21T12:00:00Z') / 1000);
});
test('URL dedup strips tracking only and retains query article identities and independent sources', () => {
  assert.equal(
    articleUrl('https://example.org/?p=1&source=alpha&ref=abc&utm_source=x#hi'),
    'https://example.org/?p=1&source=alpha&ref=abc',
  );
  assert.equal(articleUrl('javascript:alert(1)'), null);
  assert.equal(articleUrl('https://u:p@example.org'), null);
  const same = parseFeed(rss.replace('?p=2', '?p=1'), source, now);
  assert.equal(same.length, 1);
  assert.notEqual(
    parseFeed(rss, source, now)[0].id,
    parseFeed(rss, newsSources[1], now)[0].id,
  );
  assert.throws(
    () => parseFeed('<html>blocked</html>', source),
    /INVALID_FEED/,
  );
  assert.throws(
    () =>
      parseFeed(
        '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
        source,
      ),
    /INVALID_FEED/,
  );
});
test('conditional feeds preserve 304 and validate each redirect via host transport; abort stops requests', async () => {
  const state = { etag: 'etag', lastModified: 'yesterday' } as NewsSourceState;
  const calls: string[] = [];
  const web: PluginWebServices = {
    fetchContent: async () => {
      throw new Error('unused');
    },
    request: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers?.['If-None-Match'], 'etag');
      return {
        url,
        headers: calls.length === 1 ? { location: '/next' } : {},
        body: new Uint8Array(),
        status: calls.length === 1 ? 302 : 304,
      };
    },
  };
  const result = await fetchFeed(
    web,
    source,
    state,
    new AbortController().signal,
  );
  assert.equal(result.items, null);
  assert.equal(result.etag, 'etag');
  assert.equal(calls.length, 2);
  await assert.rejects(fetchFeed(web, source, null, AbortSignal.abort()), {
    name: 'AbortError',
  });
  assert.equal(calls.length, 2);
});
test('news routes enforce admin source writes and validate opaque pagination cursors', async () => {
  let writes = 0;
  const store = {
    source: async () => source,
    updateSource: async () => {
      writes++;
      return source;
    },
    list: async () => ({ items: [], nextCursor: null }),
  } as unknown as NewsStore;
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('isAdmin', c.req.header('x-admin') === 'true');
    c.set('userId', 'alice');
    await next();
  });
  app.route(
    '/news',
    newsRoutes(() => ({ store, config: {} as QuantConfig })),
  );
  assert.equal(
    (
      await app.request(`/news/sources/${source.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      })
    ).status,
    403,
  );
  assert.equal(writes, 0);
  assert.equal(
    (
      await app.request(`/news/sources/${source.id}`, {
        method: 'PATCH',
        headers: { 'x-admin': 'true' },
        body: JSON.stringify({ enabled: false }),
      })
    ).status,
    200,
  );
  assert.equal(writes, 1);
  for (const method of ['POST', 'DELETE']) {
    assert.equal(
      (
        await app.request(
          method === 'POST' ? '/news/sources' : `/news/sources/${source.id}`,
          { method },
        )
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await app.request('/news/sources', {
        method: 'POST',
        headers: { 'x-admin': 'true' },
        body: JSON.stringify({
          name: 'Unsafe',
          industry: source.industry,
          enabled: true,
          url: 'file:///etc/passwd',
        }),
      })
    ).status,
    400,
  );
  assert.equal((await app.request('/news?cursor=bad')).status, 400);
  assert.equal((await app.request('/news?limit=99999')).status, 400);
  assert.equal((await app.request('/news')).status, 200);
});

test('feed-only sources keep explicit full bodies, skip summaries and empty markup, and never fetch article URLs', async () => {
  const longBody = '完整正文，不截断。'.repeat(6000);
  const full = `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <item><title>Full</title><link>https://example.org/full</link><description>Only the teaser</description><content:encoded><![CDATA[<p>${longBody}</p><p>最后一段</p><a href="/source">原始来源</a><img src="/image.png"><script>secret()</script>]]></content:encoded></item>
    <item><title>Teaser only</title><link>https://example.org/teaser</link><description>A teaser is not the body</description></item>
    <item><title>Empty</title><link>https://example.org/empty</link><content:encoded><![CDATA[<script>secret()</script><p>&nbsp;</p>]]></content:encoded></item>
  </channel></rss>`;
  let requests = 0;
  const result = await fetchFeed(
    {
      request: async (url) => {
        requests++;
        assert.equal(url, source.url);
        return {
          url,
          status: 200,
          headers: {},
          body: new TextEncoder().encode(full),
        };
      },
      fetchContent: async () => {
        throw new Error('Must never fetch article URLs');
      },
    },
    { ...source, contentMode: 'feed' },
    null,
    AbortSignal.timeout(5000),
  );
  assert.equal(requests, 1);
  assert.equal(result.items?.length, 1);
  const item = result.items![0];
  assert.equal(item.contentStatus, 'ready');
  assert.equal(item.contentProvider, 'rss');
  assert.equal(item.contentTruncated, false);
  assert.ok(item.content.length > 50000 && item.content.includes(longBody));
  assert.ok(item.content.includes('最后一段'));
  assert.match(item.content, /https:\/\/example.org\/source/);
  assert.match(item.content, /https:\/\/example.org\/image.png/);
  assert.doesNotMatch(item.content, /secret\(\)|Only the teaser/);
  assert.equal(parseFeed(full, source).length, 3); // Other sources retain the normal page-reader behavior.
});

test('Atom content supports XHTML, escaped HTML and literal text without treating summaries as bodies', async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>XHTML</title><link href="https://example.org/xhtml"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>完整的 XHTML 正文段落</p></div></content></entry>
    <entry><title>HTML</title><link href="https://example.org/html"/><content type="html">&lt;p&gt;完整的 HTML 正文段落&lt;/p&gt;</content></entry>
    <entry><title>Text</title><link href="https://example.org/text"/><content type="text">literal &lt;tag&gt; stays text</content></entry>
    <entry><title>Summary</title><link href="https://example.org/summary"/><summary>Summary only</summary></entry>
  </feed>`;
  const result = await fetchFeed(
    {
      request: async (url) => ({
        url,
        status: 200,
        headers: {},
        body: new TextEncoder().encode(atom),
      }),
      fetchContent: async () => {
        throw new Error('unused');
      },
    },
    { ...source, contentMode: 'feed' },
    null,
    AbortSignal.timeout(5000),
  );
  assert.equal(result.items?.length, 3);
  assert.ok(result.items![0].content.includes('完整的 XHTML 正文段落'));
  assert.ok(result.items![1].content.includes('完整的 HTML 正文段落'));
  assert.ok(
    result.items![2].content.includes('tag') &&
      result.items![2].content.includes('stays text'),
  );
});
