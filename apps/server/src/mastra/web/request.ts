import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import {
  Agent,
  buildConnector,
  fetch as fetchRequest,
  ProxyAgent,
  Socks5ProxyAgent,
} from 'undici';
import { isPublicAddress } from '../../modules/providers/network.js';
import { allowAllNetworks } from '../../modules/network/policy.js';

export class WebRequestError extends Error {
  constructor(
    public readonly code: 'INVALID_URL' | 'REQUEST_FAILED' | 'TOO_LARGE',
  ) {
    super(code);
  }
}

export function webUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebRequestError('INVALID_URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new WebRequestError('INVALID_URL');
  return url;
}

export async function publicWebAddress(value: string, signal: AbortSignal) {
  const url = webUrl(value);
  const unrestricted = allowAllNetworks();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal.throwIfAborted();
    if (
      !addresses.length ||
      (!unrestricted &&
        addresses.some(({ address }) => !isPublicAddress(address)))
    )
      throw new WebRequestError('INVALID_URL');
    return addresses[0]!;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export type WebResource = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};
export type WebRequestOptions = {
  signal: AbortSignal;
  /** Connection and response inactivity timeout; 0 disables transport timers. */
  timeoutMs?: number;
  maxBytes?: number;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string | Buffer;
};

function pinnedLookup(address: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

async function webDispatcher(
  url: string,
  options: WebRequestOptions,
  readerProxy?: URL,
) {
  const timeout = options.timeoutMs;
  const agentOptions = { headersTimeout: timeout, bodyTimeout: timeout };
  if (readerProxy) {
    // The proxy resolves the administrator-configured reader. TLS still authenticates
    // the reader before sending its key. Page URLs never enter this branch.
    if (webUrl(url).protocol !== 'https:')
      throw new WebRequestError('INVALID_URL');
    if (!allowAllNetworks()) await publicWebAddress(url, options.signal);
    const address = await publicWebAddress(
      'http://' + readerProxy.host,
      options.signal,
    );
    const connect = { timeout, lookup: pinnedLookup(address) };
    if (readerProxy.protocol === 'socks5:') {
      return new Socks5ProxyAgent(readerProxy, {
        connect: buildConnector(connect),
      });
    }
    return new ProxyAgent({
      ...agentOptions,
      uri: readerProxy.href,
      proxyTls: connect,
    });
  }
  const address = await publicWebAddress(url, options.signal);
  return new Agent({
    ...agentOptions,
    connect: { timeout, lookup: pinnedLookup(address) },
  });
}

/** Stream through the same destination validation and pinned connection as buffered requests. */
export async function streamWebResource(
  url: string,
  options: WebRequestOptions,
  consume: {
    response: (response: Omit<WebResource, 'body'>) => void;
    chunk: (chunk: Uint8Array) => Promise<void>;
  },
) {
  const dispatcher = await webDispatcher(url, options);
  try {
    const response = await fetchRequest(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      dispatcher,
      redirect: 'manual',
    });
    consume.response({
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        options.signal.throwIfAborted();
        size += chunk.length;
        if (size > (options.maxBytes ?? 5_000_000))
          throw new WebRequestError('TOO_LARGE');
        await consume.chunk(chunk);
      }
    if (!size) throw new WebRequestError('REQUEST_FAILED');
  } catch (error) {
    if (error instanceof WebRequestError || options.signal.aborted) throw error;
    throw new WebRequestError('REQUEST_FAILED');
  } finally {
    await dispatcher.destroy();
  }
}

// Validate every destination and pin DNS to the connection, including browser resources.
// Redirects are returned to the caller; credentials are never forwarded automatically.
export async function requestWebResource(
  url: string,
  options: WebRequestOptions,
  readerProxy?: URL,
): Promise<WebResource> {
  const dispatcher = await webDispatcher(url, options, readerProxy);
  try {
    const response = await fetchRequest(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      dispatcher,
      redirect: 'manual',
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        options.signal.throwIfAborted();
        size += chunk.length;
        if (size > (options.maxBytes ?? 5_000_000))
          throw new WebRequestError('TOO_LARGE');
        chunks.push(chunk);
      }
    }
    return {
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.concat(chunks),
    };
  } catch (error) {
    if (error instanceof WebRequestError || options.signal.aborted) throw error;
    throw new WebRequestError('REQUEST_FAILED');
  } finally {
    await dispatcher.destroy();
  }
}

export function searchResultUrl(
  value: string,
  base?: string,
): string | undefined {
  try {
    const url = new URL(value, base);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
