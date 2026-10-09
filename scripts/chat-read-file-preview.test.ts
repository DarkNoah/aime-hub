import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readFileBlocks,
  resolveMediaSource,
  splitReadFileText,
} from '../apps/web/src/components/chat/message-preview/read-file-output.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

test('read_file recognizes native Mastra media and wildcard image types without a filename', () => {
  assert.deepEqual(
    readFileBlocks({
      __workspaceMedia: true,
      text: 'Screenshot',
      mediaType: 'image/*',
      data: png,
    }),
    [
      { type: 'text', text: 'Screenshot' },
      {
        type: 'media',
        filename: undefined,
        mediaType: 'image/png',
        source: `data:image/png;base64,${png}`,
      },
    ],
  );
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
  assert.equal(resolveMediaSource(jpeg, 'image/*').mediaType, 'image/jpeg');
  assert.equal(
    resolveMediaSource(
      Buffer.from('RIFF0000WEBPVP8 ').toString('base64'),
      'image/*',
    ).mediaType,
    'image/webp',
  );
});

test('read_file preserves concrete data URLs and normalizes wildcard data URLs once', () => {
  const source = `data:image/png;base64,${png}`;
  assert.deepEqual(resolveMediaSource(source, 'image/*'), {
    mediaType: 'image/png',
    source,
  });
  assert.equal(
    resolveMediaSource(`data:image/*;base64,${png}`, 'image/*').source,
    source,
  );
  assert.equal(resolveMediaSource(png, ' IMAGE/* ').source, source);
  assert.equal(
    resolveMediaSource(png.replace(/.{40}/g, '$&\n'), 'image/*').source,
    source,
  );
});

test('read_file supports AI SDK and MCP multimodal blocks in their original order', () => {
  const value = [
    { type: 'text', text: 'An image and a recording' },
    { type: 'image-data', mediaType: 'image/*', data: png },
    {
      type: 'file',
      mediaType: 'audio/wav',
      url: 'https://example.test/audio.wav',
    },
    {
      type: 'file-data',
      mediaType: 'application/pdf',
      filename: 'document.pdf',
      data: 'JVBERg==',
    },
    { type: 'image-url', url: 'https://example.test/no-extension' },
  ];
  const blocks = readFileBlocks({ type: 'content', value }, 'assets/source');
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['text', 'media', 'media', 'media', 'media'],
  );
  assert.equal(blocks[4].type === 'media' && blocks[4].mediaType, 'image/*');
  assert.deepEqual(
    readFileBlocks({
      content: [{ type: 'image', mimeType: 'image/png', data: png }],
    }),
    readFileBlocks(value[1]),
  );
  assert.deepEqual(
    readFileBlocks({
      type: 'json',
      value: { __workspaceMedia: true, mediaType: 'image/*', data: png },
    }),
    readFileBlocks(value[1]),
  );
});

test('read_file does not execute URLs or treat malformed bytes as a media source', () => {
  for (const value of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//unknown.test/file',
    'not valid base64!',
  ]) {
    assert.equal(
      resolveMediaSource(value, 'image/*', undefined, true).source,
      undefined,
    );
    assert.equal(resolveMediaSource(value, 'image/*').source, undefined);
  }
  assert.equal(
    resolveMediaSource('/api/files/image', 'image/*', undefined, true).source,
    '/api/files/image',
  );
  assert.equal(resolveMediaSource(undefined, 'image/*').source, undefined);
});

test('read_file keeps empty text, unrecognized output and file text that resembles JSON', () => {
  assert.deepEqual(readFileBlocks(undefined), []);
  assert.deepEqual(readFileBlocks(''), [{ type: 'text', text: '' }]);
  for (const value of [null, false, 0, { unrecognized: true }])
    assert.deepEqual(readFileBlocks(value), [{ type: 'unknown', value }]);
  const text = JSON.stringify({ mediaType: 'image/*', data: png });
  assert.deepEqual(readFileBlocks(text), [{ type: 'text', text }]);
});

test('read_file separates its header without renumbering ranges or dropping notices', () => {
  const content = '    41→const port = 4000;\n    42→\n[output truncated]';
  assert.deepEqual(
    splitReadFileText(
      `src/config.ts (lines 41-42 of 90, 820 bytes)\n${content}`,
    ),
    {
      header: 'src/config.ts (lines 41-42 of 90, 820 bytes)',
      content,
    },
  );
  assert.deepEqual(splitReadFileText('empty.txt (0 bytes)\n'), {
    header: 'empty.txt (0 bytes)',
    content: '',
  });
  assert.deepEqual(splitReadFileText('function hello() {\n  return true;\n}'), {
    content: 'function hello() {\n  return true;\n}',
  });
});
