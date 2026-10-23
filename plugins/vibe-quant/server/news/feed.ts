import { createHash } from 'node:crypto';
import { DOMParser, parseHTML } from 'linkedom';
import type { PluginWebServices } from '@app/plugin-sdk/server';
import { feedContent } from './feed-content.js';
import type {
  NewsArticle,
  NewsSource,
  NewsSourceState,
} from '../../news-types.js';

const tracking =
  /^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|spm|share_token)$/i;
export function articleUrl(value: string, base?: string) {
  try {
    const url = new URL(value, base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (tracking.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return null;
  }
}
function plain(value: string) {
  const { document } = parseHTML(`<html><body>${value}</body></html>`);
  document.querySelectorAll('script,style').forEach((node) => node.remove());
  return document.body.textContent.replace(/\s+/g, ' ').trim();
}
export function parseFeed(
  xml: string,
  source: NewsSource,
  now = Date.now() / 1000,
  base = source.url,
): NewsArticle[] {
  // No external entities or document type expansion in untrusted feed payloads.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('INVALID_FEED_XML');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement?.localName?.split(':').pop()?.toLowerCase();
  if (!['rss', 'feed', 'rdf'].includes(root ?? ''))
    throw new Error('INVALID_FEED_XML');
  const entries = [...doc.querySelectorAll('*')].filter((node) =>
    ['item', 'entry'].includes(node.localName.split(':').pop()!),
  );
  const seen = new Set<string>();
  return entries.slice(0, 200).flatMap((node) => {
    const children = [...node.children];
    const field = (...names: string[]) =>
      children
        .find((c) => names.includes(c.localName.split(':').pop()!))
        ?.textContent?.trim() ?? '';
    const title = plain(field('title')).slice(0, 2000);
    const link = children.find(
      (c) =>
        c.localName.split(':').pop() === 'link' &&
        (!c.getAttribute('rel') || c.getAttribute('rel') === 'alternate'),
    );
    const url = articleUrl(
      link?.getAttribute('href') || link?.textContent?.trim() || field('guid'),
      base,
    );
    if (!title || !url || seen.has(url)) return [];
    // A description/summary is never promoted to a complete body in feed-only mode.
    const bodyNode =
      children.find(
        (child) => child.localName.split(':').pop() === 'encoded',
      ) ??
      (root === 'feed'
        ? children.find(
            (child) => child.localName.split(':').pop() === 'content',
          )
        : undefined);
    const content =
      bodyNode?.getAttribute('type') === 'xhtml'
        ? bodyNode.innerHTML
        : bodyNode?.getAttribute('type') === 'text'
          ? (bodyNode.textContent ?? '')
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
          : (bodyNode?.textContent?.trim() ?? '');
    if (source.contentMode === 'feed' && !content.trim()) return [];
    seen.add(url);
    const raw = field('pubDate', 'published', 'date') || field('updated');
    // Dates without an explicit offset are treated as UTC, never the host timezone.
    const parsed =
      Date.parse(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(raw)
          ? `${raw}Z`
          : raw,
      ) / 1000;
    const publishedAt =
      Number.isFinite(parsed) && parsed > 0 && parsed <= now + 86400
        ? parsed
        : null;
    return [
      {
        id: createHash('sha256').update(`${source.id}\n${url}`).digest('hex'),
        sourceId: source.id,
        sourceName: source.name,
        industry: source.industry,
        url,
        title,
        summary: plain(
          field('description', 'summary', 'content', 'encoded'),
        ).slice(0, 4000),
        publishedAt,
        publishedRaw: raw.slice(0, 200),
        discoveredAt: now,
        sortAt: publishedAt ?? now,
        content: source.contentMode === 'feed' ? content : '',
        contentStatus: 'pending' as const,
        contentFetchedAt: null,
        contentUrl: '',
        contentProvider: '',
        contentTruncated: false,
        contentError: '',
        attempts: 0,
        // First reads are immediately due, regardless of host/database clock skew.
        nextRetryAt: 0,
      },
    ];
  });
}

export async function fetchFeed(
  web: PluginWebServices,
  source: NewsSource,
  state: NewsSourceState | null,
  abortSignal: AbortSignal,
) {
  const signal = AbortSignal.any([abortSignal, AbortSignal.timeout(30_000)]);
  let url = source.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await web.request(url, {
      signal,
      maxBytes: 4_000_000,
      headers: {
        'User-Agent': 'QuantNews/1.0 RSS reader',
        Accept:
          'application/rss+xml, application/atom+xml, application/xml, text/xml',
        ...(state?.etag ? { 'If-None-Match': state.etag } : {}),
        ...(state?.lastModified
          ? { 'If-Modified-Since': state.lastModified }
          : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next =
        response.headers.location && articleUrl(response.headers.location, url);
      if (!next) throw new Error('INVALID_FEED_REDIRECT');
      url = next;
      continue;
    }
    if (response.status !== 304 && response.status !== 200)
      throw new Error(`FEED_HTTP_${response.status}`);
    const xml = new TextDecoder().decode(response.body);
    const charset = xml.match(/^\s*<\?xml[^>]*encoding=["']([^"']+)/i)?.[1];
    const decoded = charset
      ? new TextDecoder(charset).decode(response.body)
      : xml;
    let items =
      response.status === 304
        ? null
        : parseFeed(decoded, source, Date.now() / 1000, url);
    if (items && source.contentMode === 'feed') {
      const complete: NewsArticle[] = [];
      for (const item of items) {
        signal.throwIfAborted();
        const content = await feedContent(item.content, item.url);
        signal.throwIfAborted();
        if (!content) continue;
        complete.push({
          ...item,
          content,
          contentStatus: 'ready',
          contentProvider: 'rss',
          contentUrl: item.url,
          contentFetchedAt: Date.now() / 1000,
        });
      }
      items = complete;
    }
    return {
      items,
      etag: response.headers.etag ?? state?.etag ?? '',
      lastModified:
        response.headers['last-modified'] ?? state?.lastModified ?? '',
    };
  }
  throw new Error('TOO_MANY_FEED_REDIRECTS');
}
