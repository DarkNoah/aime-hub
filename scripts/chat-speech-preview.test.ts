import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpeechOutput } from '../apps/web/src/components/chat/message-preview/speech-output.js';
import { getToolAttachments } from '../apps/web/src/components/chat/tool-attachments.js';

test('compact speech results derive playback from the current thread and keep paths encoded', () => {
  const compact = {
    duration: 1,
    file_path: 'outputs/audio/hello & goodbye.wav',
    sample_rate: 8000,
  };
  const result = parseSpeechOutput(JSON.stringify(compact), 'thread/one');
  assert.equal(result?.sampleRate, 8000);
  assert.equal(result?.path, compact.file_path);
  assert.equal(result?.failed, false);
  assert.deepEqual(result?.audio, [
    {
      type: 'media',
      mediaType: 'audio/wav',
      filename: compact.file_path,
      source:
        '/api/threads/thread%2Fone/files/raw?path=outputs%2Faudio%2Fhello+%26+goodbye.wav',
    },
  ]);
  assert.deepEqual(parseSpeechOutput(compact)?.audio, []);
  const attachments = getToolAttachments(
    [
      {
        type: 'dynamic-tool',
        toolName: 'speech',
        toolCallId: 'compact-call',
        state: 'output-available',
        input: { text: 'Hello' },
        output: compact,
      },
    ],
    'thread/one',
  );
  assert.equal(
    attachments[0]?.url,
    result?.audio[0]?.type === 'media' ? result.audio[0].source : undefined,
  );
  assert.equal(attachments[0]?.workspacePath, compact.file_path);
});

test('speech previews use the saved format and raw PCM remains a downloadable file', () => {
  for (const [extension, mimeType] of [
    ['mp3', 'audio/mpeg'],
    ['opus', 'audio/ogg'],
    ['aac', 'audio/aac'],
    ['flac', 'audio/flac'],
    ['wav', 'audio/wav'],
  ]) {
    const result = parseSpeechOutput(
      {
        duration: 1,
        sample_rate: 24000,
        file_path: `outputs/audio/demo.${extension}`,
      },
      'thread',
    );
    assert.ok(result?.audio[0]?.type === 'media');
    assert.equal(result.audio[0].mediaType, mimeType);
  }
  const pcm = parseSpeechOutput(
    { duration: 1, sample_rate: 24000, file_path: 'outputs/audio/demo.pcm' },
    'thread',
  );
  assert.equal(
    pcm?.audio.some((block) => block.type === 'media'),
    false,
  );
  assert.equal(pcm?.path, 'outputs/audio/demo.pcm');
});

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
