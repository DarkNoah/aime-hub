import { parseHTML } from 'linkedom';
import {
  searchResultUrl,
  type SearchResult,
  type WebSearchInput,
  type WebSearchOptions,
  type WebSearchProvider,
} from './web-search.js';

const origin = 'https://www.sogou.com';
const maxBytes = 2_000_000;

async function readHtml(response: Response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Search engine request failed');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new Error('Search engine response is too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Only Sogou's fixed search/link endpoints are fetched. Destination pages and
// scripts are never executed; this returns their URLs for the agent to cite.
export class SogouProvider implements WebSearchProvider {
  readonly id = 'sogou';
  constructor(
    private readonly timeoutMs = 15000,
    private readonly fetchPage: typeof fetch = (...args) => fetch(...args),
  ) {}

  async webSearch(
    { query, numResults }: WebSearchInput,
    options?: WebSearchOptions,
  ): Promise<SearchResult[]> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options?.abortSignal
      ? AbortSignal.any([options.abortSignal, timeout])
      : timeout;
    signal.throwIfAborted();
    const searchUrl = new URL('/web', origin);
    searchUrl.searchParams.set('query', query);
    const response = await this.fetchPage(searchUrl, {
      signal,
      redirect: 'manual',
    });
    const { document } = parseHTML(await readHtml(response));
    for (const node of document.querySelectorAll(
      'script, style, noscript, template',
    ))
      node.remove();
    const candidates = [...document.querySelectorAll('div.vrwrap, div.rb')]
      .flatMap((element) => {
        const heading = element.querySelector('h3');
        const title = heading?.textContent
          ?.replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500);
        const link = heading?.querySelector('a')?.getAttribute('href');
        const href = link && searchResultUrl(link, origin);
        const snippet = (
          element.querySelector(
            '.str_info, .str-text, .space-txt, .text-layout',
          ) ?? element.querySelector('div')
        )?.textContent
          ?.replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2000);
        return title && href ? [{ title, href, snippet }] : [];
      })
      .slice(0, numResults * 2);
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    // Bound concurrent link resolution and preserve search-engine ranking.
    for (
      let offset = 0;
      offset < candidates.length && results.length < numResults;
      offset += 4
    ) {
      signal.throwIfAborted();
      const batch = await Promise.all(
        candidates.slice(offset, offset + 4).map(async (result) => {
          const url = new URL(result.href);
          if (url.origin !== origin) return result;
          if (url.pathname !== '/link') return;
          try {
            const page = await this.fetchPage(url, {
              signal,
              redirect: 'manual',
            });
            let target: string | undefined;
            if ([301, 302, 303, 307, 308].includes(page.status)) {
              target = page.headers.get('location') ?? undefined;
              await page.body?.cancel();
            } else {
              const { document: redirect } = parseHTML(await readHtml(page));
              const scripts = [...redirect.querySelectorAll('script')]
                .map((script) => script.textContent)
                .join('\n');
              target = scripts
                .match(
                  /(?:window\.)?location\.replace\(\s*["']([^"']+)["']\s*\)/,
                )?.[1]
                ?.replace(/\\\//g, '/');
            }
            const href = target && searchResultUrl(target);
            if (href && new URL(href).origin !== origin)
              return { ...result, href };
          } catch {
            signal.throwIfAborted();
            // A broken redirect should not discard the other search results.
          }
        }),
      );
      for (const result of batch) {
        if (!result || seen.has(result.href)) continue;
        seen.add(result.href);
        results.push(result);
        if (results.length === numResults) break;
      }
    }
    signal.throwIfAborted();
    if (!results.length)
      throw new Error('Sogou returned no readable search results');
    return results;
  }
}
