import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolAttachments } from '../apps/web/src/components/chat/tool-attachments.js';

type Tool = Parameters<typeof getToolAttachments>[0][number];
const tool = (toolCallId: string, output: unknown): Tool => ({
  type: 'dynamic-tool',
  toolName: 'custom_tool',
  toolCallId,
  state: 'output-available',
  input: {},
  output,
});
const png = 'iVBORw0KGgo=';

test('collects mixed multimodal results from every tool in group order', () => {
  const attachments = getToolAttachments([
    tool('image', {
      file_path: 'outputs/images/generated.png',
      content: [
        { type: 'text', text: 'Generated image' },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
    }),
    tool('other', {
      type: 'content',
      value: [
        { type: 'file-url', mediaType: 'audio/wav', url: '/audio.wav' },
        { type: 'file-url', mediaType: 'video/mp4', url: '/video.mp4' },
        {
          type: 'file-data',
          mediaType: 'application/pdf',
          filename: 'report.pdf',
          data: 'JVBERg==',
        },
      ],
    }),
  ]);
  assert.deepEqual(
    attachments.map(({ id }) => id),
    ['image:1', 'other:0', 'other:1', 'other:2'],
  );
  assert.deepEqual(attachments[0], {
    id: 'image:1',
    type: 'file',
    url: `data:image/png;base64,${png}`,
    mediaType: 'image/png',
    filename: 'generated.png',
    workspacePath: 'outputs/images/generated.png',
  });
  assert.deepEqual(
    attachments.map(({ mediaType }) => mediaType),
    ['image/png', 'audio/wav', 'video/mp4', 'application/pdf'],
  );
});

test('supports serialized output and workspace media without mutating the tool', () => {
  const source: Tool = {
    ...tool(
      'read',
      JSON.stringify({
        type: 'json',
        value: { __workspaceMedia: true, mediaType: 'image/*', data: png },
      }),
    ),
    input: { path: 'assets/source.png' },
  };
  const before = structuredClone(source);
  assert.equal(getToolAttachments([source])[0]?.filename, 'source.png');
  assert.equal(
    getToolAttachments([source])[0]?.workspacePath,
    'assets/source.png',
  );
  assert.equal(getToolAttachments([source])[0]?.mediaType, 'image/png');
  assert.deepEqual(source, before);
});

test('ignores text, unknown results, unavailable output and unsafe media URLs', () => {
  const image = { type: 'image-url', url: 'https://example.test/image.png' };
  const tools: Tool[] = [
    tool('text', 'ordinary output'),
    tool('json-text', {
      content: [{ type: 'text', text: JSON.stringify(image) }],
    }),
    tool('unknown', { result: image }),
    tool('missing', { type: 'image-data', mediaType: 'image/png' }),
    tool('unsafe', {
      type: 'file-url',
      mediaType: 'text/html',
      url: 'javascript:alert(1)',
    }),
    {
      type: 'tool-read_file',
      toolCallId: 'pending',
      state: 'input-available',
      input: {},
    },
    {
      type: 'tool-read_file',
      toolCallId: 'failed',
      state: 'output-error',
      input: {},
      errorText: 'failed',
    },
  ];
  assert.deepEqual(getToolAttachments(tools), []);
  assert.deepEqual(getToolAttachments([]), []);
});

test('exec text stays text and explicitly emitted images become attachments', () => {
  const output = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          type: 'image',
          mimeType: 'image/png',
          data: png,
        }),
      },
      { type: 'image', mimeType: 'image/png', data: png },
    ],
  };
  const attachments = getToolAttachments([
    { ...tool('exec-call', output), toolName: 'exec' } as Tool,
  ]);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].id, 'exec-call:1');
  assert.equal(attachments[0].url, `data:image/png;base64,${png}`);
});
