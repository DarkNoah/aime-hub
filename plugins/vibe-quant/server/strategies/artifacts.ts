import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { MAX_ARTIFACT_BYTES } from './limits.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const prefix = 'gzip-base64-v1:';

/** Bound database JSON parsing memory before the table's own compression applies. */
export async function encodeArtifact(value: string): Promise<string> {
  if (Buffer.byteLength(value) > MAX_ARTIFACT_BYTES)
    throw new Error('回测产物超过 128 MiB，请缩短区间');
  if (Buffer.byteLength(value) < 1024 * 1024 && !value.startsWith(prefix))
    return value;
  const encoded = prefix + (await compress(value)).toString('base64');
  if (
    !value.startsWith(prefix) &&
    Buffer.byteLength(encoded) >= Buffer.byteLength(value)
  )
    return value;
  if (Buffer.byteLength(encoded) > MAX_ARTIFACT_BYTES)
    throw new Error('压缩后的回测产物超过 128 MiB');
  return encoded;
}

/** Existing plain JSON artifacts remain readable; never expand beyond the limit. */
export async function decodeArtifact(
  value: string,
  limit = MAX_ARTIFACT_BYTES,
): Promise<string> {
  if (Buffer.byteLength(value) > limit) throw new Error('回测产物超过大小限制');
  if (!value.startsWith(prefix)) return value;
  return (
    await decompress(Buffer.from(value.slice(prefix.length), 'base64'), {
      maxOutputLength: limit,
    })
  ).toString('utf8');
}
