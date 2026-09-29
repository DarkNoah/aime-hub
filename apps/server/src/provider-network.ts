import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return (
    family === 6 &&
    globalV6.check(address, 'ipv6') &&
    !blocked.check(address, 'ipv6')
  );
}

// Pin the validated DNS result to the socket; never follow redirects with credentials.
export async function requestProviderJson(
  urlString: string,
  apiKey?: string,
  maxBytes = 2_000_000,
): Promise<unknown> {
  const url = new URL(urlString);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol !== 'https:' && !!apiKey) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new ProviderError('INVALID_URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError('UPSTREAM_ERROR', 502)),
          5000,
        );
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicAddress(address))
    )
      throw new ProviderError('INVALID_URL');
    const address = addresses[0]!;
    return await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
          headers: {
            accept: 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.destroy();
            reject(new ProviderError('UPSTREAM_ERROR', 502));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy(new ProviderError('UPSTREAM_ERROR', 502));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new ProviderError('UPSTREAM_ERROR', 502));
            }
          });
        },
      );
      request.on('error', reject);
      request.end();
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('UPSTREAM_ERROR', 502);
  } finally {
    clearTimeout(timer);
  }
}
