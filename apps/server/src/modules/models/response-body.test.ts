import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { decodeResponseBody } from './response-body.js';

test('decodes layered and interrupted compression without changing the source bytes', async () => {
  const text = 'data: {"delta":"你好🌍"}\n\n';
  const gzip = gzipSync(Buffer.from(text));
  assert.deepEqual(
    await decodeResponseBody(brotliCompressSync(gzip), 'gzip, br', true),
    { responseBody: text, responseBodyEncoding: 'utf8' },
  );
  const partial = gzip.subarray(0, -8);
  const original = Buffer.from(partial);
  assert.deepEqual(await decodeResponseBody(partial, 'gzip', false), {
    responseBody: text,
    responseBodyEncoding: 'utf8',
  });
  assert.deepEqual(partial, original);
  assert.deepEqual(await decodeResponseBody(Buffer.alloc(0), 'gzip', true), {
    responseBody: '',
    responseBodyEncoding: 'utf8',
  });
});

test('preserves undecodable, unsupported and non-text responses losslessly as Base64', async () => {
  for (const [bytes, encoding] of [
    [Buffer.from('not a gzip stream'), 'gzip'],
    [Buffer.from([0xff, 0xfe]), null],
    [Buffer.from('a\0b'), null],
    [Buffer.from('opaque bytes'), 'unsupported'],
  ] as const) {
    const decoded = await decodeResponseBody(bytes, encoding, true);
    assert.equal(decoded.responseBodyEncoding, 'base64');
    assert.deepEqual(Buffer.from(decoded.responseBody, 'base64'), bytes);
  }
});
