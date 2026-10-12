import { promisify } from 'node:util';
import { isUtf8 } from 'node:buffer';
import { brotliDecompress, gunzip, inflate, constants } from 'node:zlib';

const decompressors = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
};

/** Decode a copy of transport bytes; never consume or alter the caller's stream. */
export async function decodeResponseBody(
  bytes: Buffer,
  contentEncoding: string | null,
  complete: boolean,
): Promise<{ responseBody: string; responseBodyEncoding: 'utf8' | 'base64' }> {
  if (!bytes.length) return { responseBody: '', responseBodyEncoding: 'utf8' };
  try {
    let decoded = bytes;
    const encodings = (contentEncoding ?? '')
      .toLowerCase()
      .split(',')
      .map((encoding) => encoding.trim())
      .filter((encoding) => encoding && encoding !== 'identity');
    for (const encoding of encodings.reverse()) {
      if (encoding !== 'gzip' && encoding !== 'deflate' && encoding !== 'br')
        throw new Error('Unsupported content encoding');
      decoded = await decompressors[encoding](
        decoded,
        complete
          ? {}
          : {
              // Preserve a decodable prefix for interrupted compressed responses.
              finishFlush:
                encoding === 'br'
                  ? constants.BROTLI_OPERATION_FLUSH
                  : constants.Z_SYNC_FLUSH,
            },
      );
    }
    if (!isUtf8(decoded) || decoded.includes(0))
      throw new Error('Response is not storable UTF-8 text');
    return {
      responseBody: decoded.toString('utf8'),
      responseBodyEncoding: 'utf8',
    };
  } catch {
    // Retain exact received bytes when a body cannot be decoded as UTF-8 text.
    return {
      responseBody: bytes.toString('base64'),
      responseBodyEncoding: 'base64',
    };
  }
}
