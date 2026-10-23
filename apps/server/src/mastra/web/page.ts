import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import type { WebFetchResult } from '../providers/base-provider.js';
import {
  assertWechatResult,
  assertWechatUrl,
  isWechatUrl,
  prepareWechatArticle,
} from './wechat.js';
import {
  requestWebResource,
  WebRequestError,
  webUrl,
  type WebRequestOptions,
} from './request.js';

export async function extractWebContent(
  html: string,
  url: string,
): Promise<WebFetchResult> {
  const wechat = isWechatUrl(url) ? prepareWechatArticle(html, url) : undefined;
  const { document } = wechat ?? parseHTML(html);
  // linkedom does not execute scripts or load resources. Keep metadata for Defuddle,
  // and normalize relative links against the final URL before conversion.
  let base = url;
  const declaredBase = document
    .querySelector('base[href]')
    ?.getAttribute('href');
  try {
    const candidate = new URL(declaredBase ?? url, url);
    if (['http:', 'https:'].includes(candidate.protocol)) base = candidate.href;
  } catch {
    /* Ignore malformed base elements. */
  }
  for (const node of document.querySelectorAll('[href], [src]')) {
    for (const attribute of ['href', 'src']) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      try {
        const target = new URL(value, base);
        if (
          ['http:', 'https:'].includes(target.protocol) &&
          !target.username &&
          !target.password
        )
          node.setAttribute(attribute, target.href);
        else node.removeAttribute(attribute);
      } catch {
        node.removeAttribute(attribute);
      }
    }
  }
  const article = await Defuddle(document as unknown as Document, url, {
    ...wechat?.options,
    markdown: true,
    // All network access stays in the bounded, cancellable request/browser stages.
    useAsync: false,
  });
  const markdown = article.content.trim();
  if (!markdown) throw new Error('No readable page content');
  const title = wechat?.title || article.title?.trim();
  const result = {
    content:
      title && !markdown.startsWith(`# ${title}\n`) && markdown !== `# ${title}`
        ? `# ${title}\n\n${markdown}`
        : markdown,
    title,
    url,
    contentType: 'text/markdown',
  };
  assertWechatResult(url, result);
  return result;
}

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
    assertWechatUrl(current);
    const response = await request(current, { ...options, headers });
    if (redirects.has(response.status) && response.headers.location) {
      current = webUrl(new URL(response.headers.location, current).href).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error(`ARTICLE_HTTP_${response.status}`);
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
      const result = { content, url: current, contentType: type };
      assertWechatResult(url, result);
      return result;
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
  const { chromium } = await import('../../lib/browser.js');
  const browser = await chromium.launch({ headless: true, timeout: timeoutMs });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= browser.close());
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
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
        // Keep HTTP identity aligned with stealth's navigator values. Only
        // forward these public headers, never page cookies or credentials.
        const browserHeaders = await requestInfo.allHeaders();
        const requestHeaders: Record<string, string> = {
          accept: headers.accept,
        };
        for (const name of [
          'accept',
          'user-agent',
          'accept-language',
          'sec-ch-ua',
          'sec-ch-ua-mobile',
          'sec-ch-ua-platform',
        ]) {
          if (browserHeaders[name]) requestHeaders[name] = browserHeaders[name];
        }
        const response = await request(requestInfo.url(), {
          signal,
          headers: requestHeaders,
        });
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
    if (!response?.ok())
      throw new Error(`ARTICLE_HTTP_${response?.status() ?? 0}`);
    assertWechatUrl(page.url());
    if (isWechatUrl(url)) {
      await page
        .waitForFunction(
          () => {
            const root = document.querySelector('#js_content');
            return (
              !!root &&
              ((root.textContent?.trim().length ?? 0) >= 10 ||
                !!root.querySelector('img[data-src], img[src]'))
            );
          },
          undefined,
          { timeout: Math.min(timeoutMs, 8000) },
        )
        .catch(() => {});
    }
    await page
      .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000) })
      .catch(() => {});
    signal.throwIfAborted();
    const html = await page.content();
    if (Buffer.byteLength(html) > 5_000_000)
      throw new WebRequestError('TOO_LARGE');
    return extractWebContent(html, webUrl(page.url()).href);
  } catch (error) {
    // Browser shutdown interrupts pending Playwright operations. Preserve the
    // caller's cancellation reason instead of reporting it as a page failure.
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await close();
  }
}
