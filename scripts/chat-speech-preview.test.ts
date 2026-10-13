import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpeechOutput } from '../apps/web/src/components/chat/message-preview/speech-output.js';

const output = {
  ok: true,
  file_path: 'outputs/audio/demo.wav',
  model: 'xinference/VoxCPM2',
  sampleRate: 48000,
  content: [
    {
      type: 'text',
      text: 'Speech saved to "outputs/audio/demo.wav" (4.96 s, 48000 Hz, WAV).\nVoice option was ignored.',
    },
    {
      type: 'file',
      url: '/api/threads/demo/files/raw?path=outputs/audio/demo.wav',
      mimeType: 'audio/wav',
      filename: 'outputs/audio/demo.wav',
    },
  ],
};

test('speech preview accepts persisted JSON and keeps audio, path, model and warnings', () => {
  const result = parseSpeechOutput(JSON.stringify(output));
  assert.equal(result?.path, output.file_path);
  assert.equal(result?.model, output.model);
  assert.equal(result?.sampleRate, 48000);
  assert.equal(result?.failed, false);
  assert.equal(result?.message, 'Voice option was ignored.');
  assert.equal(result?.audio.length, 1);
  assert.equal(
    result?.audio[0]?.type === 'media' && result.audio[0].source,
    output.content[1].url,
  );
});

test('speech failure preserves the error and does not invent metadata', () => {
  const result = parseSpeechOutput({
    ok: false,
    isError: true,
    sampleRate: -1,
    content: [{ type: 'text', text: 'Speech provider timed out.' }],
  });
  assert.equal(result?.failed, true);
  assert.equal(result?.message, 'Speech provider timed out.');
  assert.equal(result?.sampleRate, undefined);
  assert.deepEqual(result?.audio, []);
});

test('unknown output falls back and unsafe audio sources remain unavailable', () => {
  for (const value of [
    undefined,
    null,
    'invalid JSON',
    '[]',
    {},
    { ok: true },
  ]) {
    assert.equal(parseSpeechOutput(value), null);
  }
  const result = parseSpeechOutput({
    ...output,
    sampleRate: Infinity,
    content: [
      { type: 'file', mimeType: 'audio/wav', url: 'javascript:alert(1)' },
    ],
  });
  assert.equal(result?.sampleRate, undefined);
  assert.equal(
    result?.audio[0]?.type === 'media' && result.audio[0].source,
    undefined,
  );
});
