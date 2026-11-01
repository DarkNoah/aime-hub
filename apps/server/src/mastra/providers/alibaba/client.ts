import { z } from 'zod';
import { requestWebResource, webUrl } from '../../web/request.js';

const envelope = z.looseObject({
  code: z.string().nullish(),
  error: z.unknown().optional(),
  status_code: z.number().optional(),
});

/** Use the server's DNS-pinned transport for API calls and signed media URLs. */
export class AlibabaClient {
  constructor(
    private readonly apiKey: string,
    readonly request = requestWebResource,
  ) {}

  async json(
    url: string,
    options: {
      body?: object;
      signal: AbortSignal;
      headers?: Record<string, string>;
      authenticated?: boolean;
      timeoutMs?: number;
      maxBytes?: number;
    },
  ): Promise<unknown> {
    const { signal, body, authenticated = true, timeoutMs = 300_000 } = options;
    signal.throwIfAborted();
    webUrl(url);
    if (authenticated && !this.apiKey.trim())
      throw new Error('Alibaba API key is not set');
    const response = await this.request(url, {
      method: body ? 'POST' : 'GET',
      signal,
      timeoutMs,
      maxBytes: options.maxBytes ?? 20_000_000,
      headers: authenticated
        ? {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            ...options.headers,
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    signal.throwIfAborted();
    if (response.status !== 200)
      throw new Error(`Alibaba request failed (HTTP ${response.status})`);
    let data: unknown;
    try {
      data = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new Error('Alibaba returned invalid JSON');
    }
    const parsed = envelope.parse(data);
    if (
      parsed.code ||
      parsed.error ||
      (parsed.status_code && parsed.status_code !== 200)
    )
      // Do not expose upstream messages containing request data or credentials.
      throw new Error('Alibaba request returned an error');
    return data;
  }

  async download(
    url: string,
    signal: AbortSignal,
    maxBytes: number,
    timeoutMs = 300_000,
  ) {
    signal.throwIfAborted();
    webUrl(url);
    // Signed URLs must never receive the provider Authorization header.
    const response = await this.request(url, { signal, timeoutMs, maxBytes });
    signal.throwIfAborted();
    if (response.status !== 200 || !response.body.length)
      throw new Error(
        `Alibaba media download failed (HTTP ${response.status})`,
      );
    return response.body;
  }
}
