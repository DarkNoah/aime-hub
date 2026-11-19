import type { BrowserContext, Page, Request, Response } from 'playwright-core';
import type {
  NetworkCaptureScope,
  NetworkCaptureStore,
  NetworkRequestHandle,
  NetworkRequestPatch,
} from './network-store.js';

const REDACTED = '[redacted]';
const MAX_BODY = 64 * 1024;
const MAX_DEFLATE_WIRE_BYTES = 2048;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 2048;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_BODY_READS = 8;

function sensitive(name: string) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    /password|passwd|passphrase|secret|token|cookie|authorization|authentication|authkey|auth$|credential|apikey|accesskey|privatekey|csrf|xsrf|session|signature/.test(
      key,
    ) || ['auth', 'session', 'sid', 'key', 'jwt', 'pwd', 'otp'].includes(key)
  );
}

function redactText(text: string) {
  return text
    .replace(
      /(^|\n)((?:cookie|set-cookie|(?:proxy-)?authorization)\s*:\s*)[^\r\n]*/gi,
      '$1$2' + REDACTED,
    )
    .replace(/(https?:\/\/)[^\s/@?#]+@/gi, '$1')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z\d+/=._~-]+/gi, '$1 ' + REDACTED)
    .replace(/\beyJ[A-Za-z\d_-]+\.eyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+/g, REDACTED)
    .replace(
      /(\b[\w.-]{0,64}(?:password|passwd|passphrase|secret|token|cookie|authorization|credential|api[-_]?key|access[-_]?key|private[-_]?key|csrf|xsrf|session|signature|jwt|pwd|otp)[\w.-]{0,64}["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
      '$1' + REDACTED,
    );
}

function sanitizeParams(params: URLSearchParams) {
  const sanitized = new URLSearchParams();
  for (const [name, value] of params) {
    const secret = sensitive(name) || /^(code|state|sig)$/i.test(name);
    sanitized.append(name, secret ? REDACTED : redactText(value));
  }
  return sanitized;
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = sanitizeParams(url.searchParams).toString();
    return url.href.slice(0, 8192);
  } catch {
    return undefined;
  }
}

function safeHeaders(headers: Record<string, string>, base: string) {
  const result: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [name, value] of Object.entries(headers).slice(0, MAX_HEADERS)) {
    if (name.length > 256) continue;
    let sanitized: string;
    if (sensitive(name)) sanitized = REDACTED;
    else if (/^(location|referer|content-location)$/i.test(name)) {
      try {
        sanitized = safeUrl(new URL(value, base).href) ?? REDACTED;
      } catch {
        sanitized = REDACTED;
      }
    } else sanitized = redactText(value);
    const limited = sanitized.slice(0, MAX_HEADER_VALUE);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(limited);
    if (bytes > MAX_HEADER_BYTES) break;
    result[name] = limited;
  }
  return result;
}

type Body = { text: string } | { omitted: string };
function bodyType(headers: Record<string, string>) {
  return (headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
}

function bodyPolicy(headers: Record<string, string>) {
  const type = bodyType(headers);
  if (headers['content-disposition']?.toLowerCase().includes('attachment'))
    return 'download';
  if (
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'text/plain' ||
    type === 'application/x-www-form-urlencoded'
  )
    return undefined;
  return 'unsupported content type';
}

function decodeBody(buffer: Buffer, headers: Record<string, string>): Body {
  if (buffer.length > MAX_BODY) return { omitted: 'size limit' };
  if (!buffer.length) return { text: '' };
  const omitted = bodyPolicy(headers);
  if (omitted) return { omitted };
  const type = bodyType(headers);
  const text = buffer.toString('utf8');
  if (type === 'application/x-www-form-urlencoded')
    return { text: sanitizeParams(new URLSearchParams(text)).toString() };
  if (
    type === 'application/json' ||
    type.endsWith('+json') ||
    (type === 'text/plain' && /^\s*[[{]/.test(text))
  ) {
    try {
      const json: unknown = JSON.parse(text, (key, value: unknown) =>
        sensitive(key)
          ? REDACTED
          : typeof value === 'string'
            ? redactText(value)
            : value,
      );
      return { text: JSON.stringify(json) };
    } catch {
      // A partial or malformed document cannot be safely redacted as JSON.
      return { omitted: 'invalid JSON' };
    }
  }
  return { text: redactText(text) };
}

async function responseBody(
  response: Response,
  request: Request,
): Promise<Body> {
  const status = response.status();
  if (request.method() === 'HEAD' || status === 204 || status === 304)
    return { text: '' };
  if (status >= 300 && status < 400) return { omitted: 'redirect' };
  const headers = response.headers();
  const omitted = bodyPolicy(headers);
  if (omitted) return { omitted };
  const encoding = headers['content-encoding']?.trim().toLowerCase();
  const compressed = !!encoding && encoding !== 'identity';
  if (compressed && !['gzip', 'x-gzip', 'deflate'].includes(encoding))
    return { omitted: 'unsupported content encoding' };
  // A DEFLATE length/distance pair emits at most 258 bytes per two bits.
  // Even an adversarial stream below this wire limit decodes to roughly 2 MiB at most.
  const wireLimit = compressed ? MAX_DEFLATE_WIRE_BYTES : MAX_BODY;
  if (Number(headers['content-length']) > wireLimit)
    return { omitted: 'size limit' };
  // sizes() is the encoded transfer size, including for chunked responses.
  const { responseBodySize } = await request.sizes();
  if (
    !Number.isSafeInteger(responseBodySize) ||
    responseBodySize < 0 ||
    (responseBodySize === 0 && headers['content-length'] !== '0')
  )
    return { omitted: 'unknown size' };
  if (responseBodySize > wireLimit) return { omitted: 'size limit' };
  if (responseBodySize === 0) return { text: '' };
  return decodeBody(await response.body(), headers);
}

type Seen = {
  startedAt: number;
  ticket: number;
  handle?: NetworkRequestHandle;
  page?: Page;
  received?: boolean;
  finished?: boolean;
};

/** Context timestamps identify the capture generation. Only a proven Page owner can admit a record. */
export class NetworkCaptureEvents {
  private readonly seen = new WeakMap<Request, Seen>();
  private readonly cleanupPages = new Map<Page, () => void>();
  private reads = 0;
  private disposed = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly store: NetworkCaptureStore,
  ) {
    context.on('request', this.stamp);
    context.once('close', this.dispose);
  }

  private readonly stamp = (request: Request) => {
    this.seen.set(request, {
      startedAt: Date.now(),
      ticket: this.store.captureTicket(),
    });
  };

  track(page: Page, scope: NetworkCaptureScope) {
    if (this.disposed || this.cleanupPages.has(page)) return;
    const pending = new Map<NetworkRequestHandle, number>();
    const admit = (request: Request): Seen | undefined => {
      const seen = this.seen.get(request);
      if (!seen) return;
      if (seen.page)
        return seen.page === page && seen.handle ? seen : undefined;
      if (!this.store.isActive(scope)) return;
      const url = safeUrl(request.url());
      if (!url) return;
      const previous = request.redirectedFrom();
      if (previous && !this.seen.get(previous)?.handle) replay(previous);
      const redirect = previous && this.seen.get(previous);
      const headers = request.headers();
      seen.page = page;
      let handle: NetworkRequestHandle | undefined;
      try {
        handle = this.store.begin(
          scope,
          {
            startedAt: seen.startedAt,
            url,
            method: request.method(),
            resourceType: request.resourceType(),
            redirectedFrom:
              redirect?.page === page ? redirect.handle?.id : undefined,
            requestHeaders: safeHeaders(headers, url),
          },
          seen.ticket,
        );
      } catch {
        return;
      }
      if (!handle) return;
      seen.handle = handle;
      // Long-lived event streams may outlast their on-disk record.
      if (pending.size >= 512) {
        for (const existing of pending.keys())
          if (!this.store.isRetained(existing)) pending.delete(existing);
      }
      pending.set(handle, seen.startedAt);
      const post = request.postDataBuffer();
      if (post) {
        const encoded = headers['content-encoding']?.toLowerCase();
        const body =
          encoded && encoded !== 'identity'
            ? { omitted: 'encoded request' }
            : decodeBody(post, headers);
        this.write(
          handle,
          'text' in body
            ? { requestBody: body.text }
            : { requestBodyOmitted: body.omitted },
        );
      }
      return seen;
    };
    const received = (response: Response) => {
      const request = response.request();
      const seen = admit(request);
      if (seen?.handle && !seen.received) {
        seen.received = true;
        this.write(seen.handle, {
          status: response.status(),
          mimeType: bodyType(response.headers()),
          responseHeaders: safeHeaders(response.headers(), request.url()),
        });
      }
    };
    const ended = (request: Request) => {
      const seen = admit(request);
      if (!seen?.handle || seen.finished) return;
      seen.finished = true;
      pending.delete(seen.handle);
      const durationMs = Math.max(0, Date.now() - seen.startedAt);
      const failure = request.failure();
      if (failure) {
        const error =
          failure.errorText.match(/\bnet::ERR_[A-Z0-9_]+\b/)?.[0] ??
          'request failed';
        this.write(seen.handle, { state: 'failed', durationMs, error });
        return;
      }
      const response = request.existingResponse();
      if (response) received(response);
      void this.finish(seen.handle, request, response, durationMs);
    };
    const replay = (request: Request) => {
      // page.requests() includes early popup navigations for which request.frame()
      // is unavailable. The page (or the browser-provided redirect chain) proves ownership.
      admit(request);
      const response = request.existingResponse();
      if (response) received(response);
      if (request.failure() || request.timing().responseEnd >= 0)
        ended(request);
    };
    page.on('request', admit);
    page.on('response', received);
    page.on('requestfinished', ended);
    page.on('requestfailed', ended);
    const cleanup = () => {
      page
        .off('request', admit)
        .off('response', received)
        .off('requestfinished', ended)
        .off('requestfailed', ended)
        .off('close', cleanup);
      this.cleanupPages.delete(page);
      for (const [handle, startedAt] of pending)
        this.write(handle, {
          state: 'failed',
          error: 'page closed',
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      pending.clear();
    };
    this.cleanupPages.set(page, cleanup);
    page.once('close', cleanup);
    if (this.store.isActive(scope))
      void page
        .requests()
        .then((requests) => {
          if (!this.disposed && this.cleanupPages.has(page))
            requests.forEach(replay);
        })
        .catch(() => {});
  }

  private write(handle: NetworkRequestHandle, patch: NetworkRequestPatch) {
    void this.store.update(handle, patch).catch(() => {});
  }

  private async finish(
    handle: NetworkRequestHandle,
    request: Request,
    response: Response | null,
    durationMs: number,
  ) {
    if (!this.store.isRetained(handle)) return;
    let body: Body;
    if (!response || this.reads >= MAX_BODY_READS) {
      body = { omitted: response ? 'capture busy' : 'response unavailable' };
    } else {
      this.reads++;
      try {
        body = await responseBody(response, request);
      } catch {
        body = { omitted: 'response unavailable' };
      } finally {
        this.reads--;
      }
    }
    this.write(handle, {
      state: 'finished',
      durationMs,
      ...('text' in body
        ? { responseBody: body.text }
        : { responseBodyOmitted: body.omitted }),
    });
  }

  readonly dispose = () => {
    this.disposed = true;
    this.context.off('request', this.stamp).off('close', this.dispose);
    for (const cleanup of this.cleanupPages.values()) cleanup();
  };
}
