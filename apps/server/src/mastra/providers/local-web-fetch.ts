import {
  requestWebResource,
  WebRequestError,
  webUrl,
  type WebRequestOptions,
} from './web-request.js';
import { extractWebContent } from './web-content.js';
import type {
  WebFetchOptions,
  WebFetchProvider,
  WebFetchResult,
} from './web-fetch.js';

const headers = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
};
const redirects = new Set([301, 302, 303, 307, 308]);

export async function readWebPage(
  url: string,
  options: WebRequestOptions,
  request = requestWebResource,
) {
  let current = webUrl(url).href;
  for (let count = 0; count <= 5; count++) {
    options.signal.throwIfAborted();
    const response = await request(current, { ...options, headers });
    if (redirects.has(response.status) && response.headers.location) {
      current = webUrl(new URL(response.headers.location, current).href).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error('Page request failed');
    const type = response.headers['content-type']
      ?.split(';')[0]
      .trim()
      .toLowerCase();
    const content = response.body.toString('utf8');
    if (
      type === 'text/plain' ||
      type === 'text/markdown' ||
      type === 'application/json'
    ) {
      if (!content.trim()) throw new Error('Page is empty');
      return { content, url: current, contentType: type };
    }
    if (type && type !== 'text/html' && type !== 'application/xhtml+xml')
      throw new Error('Unsupported page format');
    return extractWebContent(content, current);
  }
  throw new Error('Too many page redirects');
}

export async function readBrowserPage(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  request = requestWebResource,
): Promise<WebFetchResult> {
  signal.throwIfAborted();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, timeout: timeoutMs });
  const close = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      userAgent: headers['user-agent'],
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    // Isolated browser reads use the same pinned public-network path as direct requests.
    // Never forward browser cookies or allow a page to issue writes to other services.
    await context.route('**/*', async (route) => {
      const requestInfo = route.request();
      if (
        requestInfo.method() !== 'GET' ||
        ['image', 'media', 'font'].includes(requestInfo.resourceType())
      ) {
        await route.abort().catch(() => {});
        return;
      }
      try {
        const response = await request(requestInfo.url(), { signal, headers });
        const responseHeaders = { ...response.headers };
        for (const name of [
          'content-encoding',
          'content-length',
          'transfer-encoding',
          'set-cookie',
        ])
          delete responseHeaders[name];
        await route.fulfill({
          status: response.status,
          headers: responseHeaders,
          body: response.body,
        });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    if (!response?.ok()) throw new Error('Browser page request failed');
    await page
      .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000) })
      .catch(() => {});
    signal.throwIfAborted();
    const html = await page.content();
    if (Buffer.byteLength(html) > 5_000_000)
      throw new WebRequestError('TOO_LARGE');
    return extractWebContent(html, webUrl(page.url()).href);
  } finally {
    signal.removeEventListener('abort', close);
    await browser.close();
  }
}

export class LocalWebFetchProvider implements WebFetchProvider {
  readonly id = 'local';
  constructor(
    private readonly timeoutMs = 20000,
    private readonly readDirect = readWebPage,
    private readonly readBrowser = readBrowserPage,
  ) {}

  async webFetch(
    url: string,
    options?: WebFetchOptions,
  ): Promise<WebFetchResult> {
    webUrl(url);
    const makeSignal = () =>
      AbortSignal.any([
        AbortSignal.timeout(this.timeoutMs),
        ...(options?.abortSignal ? [options.abortSignal] : []),
      ]);
    try {
      return await this.readDirect(url, { signal: makeSignal() });
    } catch (error) {
      options?.abortSignal?.throwIfAborted();
      if (error instanceof WebRequestError && error.code === 'INVALID_URL')
        throw error;
      return this.readBrowser(url, makeSignal(), this.timeoutMs);
    }
  }
}
