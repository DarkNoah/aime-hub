import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeArtifact,
  decodeArtifact,
} from '../server/strategies/artifacts.js';
import { sha256 } from '../server/strategies/sources.js';

test('large frozen artifacts round-trip as compressed text with unchanged original hash', async () => {
  const source = JSON.stringify({
    bars: Array.from({ length: 15000 }, (_, time) => ({
      time,
      symbol: 'KQ.m@CFFEX.IM',
      note: '主连价格模拟',
      open: 6000,
      close: 6001,
    })),
  });
  const stored = await encodeArtifact(source);
  assert.ok(stored.startsWith('gzip-base64-v1:'));
  assert.ok(Buffer.byteLength(stored) < Buffer.byteLength(source) / 10);
  const decoded = await decodeArtifact(stored);
  assert.equal(decoded, source);
  assert.equal(sha256(decoded), sha256(source));
  await assert.rejects(decodeArtifact(stored, Buffer.byteLength(source) - 1));
});

test('legacy plain artifacts stay readable and corrupt compressed artifacts fail closed', async () => {
  const legacy = '{"value":"中文"}';
  assert.equal(await encodeArtifact(legacy), legacy);
  assert.equal(await decodeArtifact(legacy), legacy);
  await assert.rejects(decodeArtifact('gzip-base64-v1:broken'));
  await assert.rejects(decodeArtifact(legacy, 5));
});
