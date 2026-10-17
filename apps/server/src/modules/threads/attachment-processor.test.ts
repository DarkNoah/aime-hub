import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { resolveModelConfig } from '@mastra/core/llm';
import { serializeAttachments } from '@aime/shared/chat-attachments';
import { MAX_IMAGE_BYTES } from '@aime/shared/threads';
import { AttachmentProcessor } from './attachment-processor.js';
import { AttachmentMediaReader } from './attachment-media.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQmcAAAAASUVORK5CYII=',
  'base64',
);
type Prompt = ProcessLLMRequestArgs['prompt'];
async function process(
  processor: AttachmentProcessor,
  prompt: Prompt,
  abortSignal?: AbortSignal,
) {
  const result = await processor.processLLMRequest({
    prompt,
    abortSignal,
  } as ProcessLLMRequestArgs);
  assert.ok(result?.prompt);
  return result.prompt;
}
const text = (prompt: Prompt) =>
  prompt
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
const files = (prompt: Prompt) =>
  prompt
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'file');

test('gates images per current model and keeps audio/video path-only without reading files or mutating history', async (t) => {
  const reader = new AttachmentMediaReader('/unused');
  const read = t.mock.method(reader, 'read', async () => {
    throw new Error('Audio/video files must not be read');
  });
  let modalities = ['image', 'video', 'audio'];
  const processor = new AttachmentProcessor(reader, () => modalities);
  const prompt: Prompt = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Compare these attachments' },
        {
          type: 'file',
          filename: 'picture.png',
          mediaType: 'image/png',
          data: png,
        },
        {
          type: 'file',
          filename: 'clip & "one".mp4',
          mediaType: 'video/mp4',
          data: Buffer.alloc(MAX_IMAGE_BYTES + 1),
        },
        {
          type: 'file',
          filename: 'sound.wav',
          mediaType: 'audio/wav',
          data: 'data:audio/wav;base64,YXVkaW8=',
        },
        {
          type: 'text',
          text: serializeAttachments([
            {
              path: '/.uploads/picture.png',
              size: png.length,
              mimeType: 'image/png',
            },
            {
              path: '/.uploads/clip & "one".mp4',
              mimeType: 'video/mp4',
              size: MAX_IMAGE_BYTES + 1,
              duration: 5,
            },
            {
              path: '/.uploads/sound.wav',
              mimeType: 'audio/wav',
              duration: 10,
              sampleRate: 16000,
            },
            { path: '/.uploads/missing.mp3', mimeType: 'audio/mpeg' },
          ]),
        },
      ],
    },
  ];
  const original = structuredClone(prompt);
  const rich = await process(processor, prompt);
  assert.equal(files(rich).length, 1);
  const user = rich[0];
  assert.equal(user.role, 'user');
  if (user.role !== 'user') return;
  for (const [index, part] of user.content.entries()) {
    if (part.type !== 'file') continue;
    assert.match(JSON.stringify(user.content[index - 1]), /<attachment /);
    assert.deepEqual(user.content[index + 1], {
      type: 'text',
      text: '</attachment>',
    });
  }
  assert.match(text(rich), /mimeType="image\/png" width="1" height="1"/);
  assert.deepEqual(
    user.content.slice(-3),
    [
      '<attachment path="/.uploads/clip &amp; &quot;one&quot;.mp4"></attachment>',
      '<attachment path="/.uploads/sound.wav"></attachment>',
      '<attachment path="/.uploads/missing.mp3"></attachment>',
    ].map((text) => ({ type: 'text', text })),
  );
  assert.doesNotMatch(
    text(rich),
    /\b(?:id|name|duration|sampleRate)="|base64|<\/?attachments>/,
  );
  assert.equal((text(rich).match(/<attachment /g) ?? []).length, 4);
  modalities = ['text'];
  const plain = await process(processor, prompt);
  assert.equal(files(plain).length, 0);
  assert.equal(text(plain), text(rich));
  modalities = ['audio'];
  assert.equal(files(await process(processor, prompt)).length, 0);
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(structuredClone(prompt), original);
});

test('large uploaded images use their own bytes, and legacy id/name metadata is normalized', async (t) => {
  const root = await realpath(await mkdtemp('/tmp/chat-attachment-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.uploads/large'), { recursive: true });
  const large = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]);
  await writeFile(join(root, '.uploads/large/same.png'), large);
  const processor = new AttachmentProcessor(
    new AttachmentMediaReader(root),
    () => ['image'],
  );
  const result = await process(processor, [
    {
      role: 'user',
      content: [
        {
          type: 'file',
          filename: 'same.png',
          mediaType: 'image/png',
          data: png,
        },
        {
          type: 'text',
          text: `<attachments>\n<attachment id="large" name="same.png" path="/.uploads/large/same.png" size="${large.length}" mimeType="image/png" />\n<attachment id="small" name="same.png" path="/.uploads/small/same.png" size="${png.length}" mimeType="image/png" />\n</attachments>`,
        },
      ],
    },
  ]);
  assert.deepEqual(
    files(result).map((file) => (file.data as Uint8Array).byteLength),
    [large.length, png.length],
  );
  assert.doesNotMatch(text(result), /\b(?:id|name)="/);
});

test('pathless drawings are wrapped, deleted/symlink files stay references, and cancellation propagates', async (t) => {
  const root = await realpath(await mkdtemp('/tmp/chat-attachment-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink('/etc/hosts', join(root, 'outside.png'));
  const processor = new AttachmentProcessor(
    new AttachmentMediaReader(root),
    () => ['image'],
  );
  const prompt: Prompt = [
    {
      role: 'user',
      content: [
        { type: 'file', mediaType: 'image/png', data: png },
        {
          type: 'text',
          text: serializeAttachments([
            { path: 'missing.png', mimeType: 'image/png' },
            { path: 'outside.png', mimeType: 'image/png' },
          ]),
        },
      ],
    },
  ];
  const result = await process(processor, prompt);
  assert.equal(files(result).length, 1);
  assert.match(
    text(result),
    /<attachment size="\d+" mimeType="image\/png" width="1" height="1">/,
  );
  assert.match(text(result), /path="missing.png"/);
  assert.match(text(result), /path="outside.png"/);
  await assert.rejects(
    process(processor, prompt, AbortSignal.abort()),
    /abort/i,
  );
});

test('ordinary prose, code examples and non-user messages retain their original contents', async () => {
  const processor = new AttachmentProcessor(
    new AttachmentMediaReader('/unused'),
    () => [],
  );
  const xml = serializeAttachments([
    { path: '.uploads/example.png', mimeType: 'image/png' },
  ]);
  const prompt: Prompt = [
    {
      role: 'user',
      content: [{ type: 'text', text: `\`\`\`xml\n${xml}\n\`\`\`` }],
    },
    { role: 'assistant', content: [{ type: 'text', text: xml }] },
    { role: 'system', content: xml },
  ];
  assert.deepEqual(await process(processor, prompt), prompt);
});

test('Responses wraps native images individually and sends audio/video as path text even for multimodal models', async (t) => {
  const processor = new AttachmentProcessor(
    new AttachmentMediaReader('/unused'),
    () => ['image', 'audio', 'video'],
  );
  const prompt = await process(processor, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this' },
        {
          type: 'file',
          filename: 'drawing.png',
          mediaType: 'image/png',
          data: png,
        },
        {
          type: 'file',
          filename: 'sound.wav',
          mediaType: 'audio/wav',
          data: Buffer.from('audio'),
        },
        {
          type: 'text',
          text: serializeAttachments([
            { path: '/.uploads/drawing.png', mimeType: 'image/png' },
            { path: '/.uploads/clip.mp4', mimeType: 'video/mp4' },
            { path: '/.uploads/sound.wav', mimeType: 'audio/wav' },
          ]),
        },
      ],
    },
  ]);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body:
    | {
        input: {
          role: string;
          content: { type: string; text?: string; image_url?: string }[];
        }[];
      }
    | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    throw new Error('CAPTURE_ONLY');
  };
  const model = await resolveModelConfig({
    providerId: 'openai',
    modelId: 'test-model',
    url: 'https://capture.invalid/v1',
    apiKey: 'test-only',
    api: 'responses',
  });
  assert.ok(model.specificationVersion === 'v2');
  await assert.rejects(
    async () => model.doGenerate({ prompt }),
    /CAPTURE_ONLY/,
  );
  assert.ok(body);
  const content = body.input[0].content;
  const image = content.findIndex((part) => part.type === 'input_image');
  assert.ok(image > 0);
  assert.match(
    content[image - 1].text!,
    /^<attachment .*width="1" height="1">$/,
  );
  assert.equal(
    content[image].image_url,
    `data:image/png;base64,${png.toString('base64')}`,
  );
  assert.equal(content[image + 1].text, '</attachment>');
  assert.deepEqual(content.slice(-2), [
    {
      type: 'input_text',
      text: '<attachment path="/.uploads/clip.mp4"></attachment>',
    },
    {
      type: 'input_text',
      text: '<attachment path="/.uploads/sound.wav"></attachment>',
    },
  ]);
  assert.equal(content.filter((part) => part.type !== 'input_text').length, 1);
  assert.doesNotMatch(JSON.stringify(content), /<\/?attachments>/);
});
