import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Agent } from '@mastra/core/agent';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { noopObserve } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createReadFileTool } from '../../mastra/tools/read_file.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==',
  'base64',
);

async function fixture(t: test.TestContext, ocr = true) {
  const directory = await mkdtemp(join(tmpdir(), 'read-file-output-'));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  const pdf = await PDFDocument.create();
  for (const text of ['ONE', 'TWO', 'THREE']) pdf.addPage().drawText(text);
  const data = await pdf.save();
  await writeFile(join(directory, 'report.pdf'), data);
  await writeFile(join(directory, 'image.png'), png);
  const tool = createReadFileTool(undefined, {
    resolveCurrentModel: async () => ({ modalitiesInput: ['image'] }),
    resolveModel: ocr
      ? async () => ({
          reference: 'test/ocr',
          model: {
            provider: 'test',
            modelId: 'ocr',
            doOCR: async () => ({
              markdown: 'First\nSecond\nThird',
              taskId: 'ocr',
            }),
          },
        })
      : undefined,
  });
  const read = async (
    input: Omit<
      Parameters<NonNullable<typeof tool.execute>>[0],
      'showLineNumbers'
    >,
  ) => {
    const result = await tool.execute!(
      { showLineNumbers: true, ...input },
      { workspace, observe: noopObserve },
    );
    assert.ok(
      result && typeof result === 'object' && 'ok' in result && result.ok,
    );
    const output = await tool.toModelOutput!(result);
    assert.ok(
      output &&
        typeof output === 'object' &&
        'type' in output &&
        output.type === 'content' &&
        'value' in output &&
        Array.isArray(output.value),
    );
    return { result, blocks: output.value };
  };
  return { tool, workspace, directory, read, size: data.length };
}

test('PDF model output keeps page metadata and line continuation outside the OCR block', async (t) => {
  const f = await fixture(t);
  const { result, blocks } = await f.read({
    path: 'report.pdf',
    parameters: { pdf_pages: '1,3' },
    offset: 2,
    limit: 1,
  });
  assert.equal(result.totalPages, 3);
  assert.deepEqual(result.selectedPages, [1, 3]);
  assert.equal(result.content[0].text, '2: Second');
  assert.deepEqual(blocks, [
    { type: 'text', text: `File: ${result.file_path}` },
    {
      type: 'text',
      text: `MIME type: application/pdf\nSize: ${f.size} bytes\nTotal pages: 3\nSelected pages (original PDF, before text slicing): 1, 3\nText source: OCR\nText lines: 2-2 of 3`,
    },
    { type: 'text', text: '<ocr-content>\n2: Second\n</ocr-content>' },
    {
      type: 'text',
      text: '[Output truncated. Showing parsed lines 2-2 of 3. Continue with offset=3.]',
    },
  ]);
  const all = await f.read({ path: 'report.pdf' });
  assert.deepEqual(all.result.selectedPages, [1, 2, 3]);
});

test('image output separates path, byte size and dimensions, OCR text and image data', async (t) => {
  const f = await fixture(t);
  const { result, blocks } = await f.read({ path: 'image.png' });
  assert.deepEqual(blocks, [
    { type: 'text', text: `File: ${result.file_path}` },
    {
      type: 'text',
      text: `MIME type: image/png\nSize: ${png.length} bytes\nDimensions: 1 x 1 pixels\nText source: OCR\nText lines: 1-3 of 3`,
    },
    {
      type: 'text',
      text: '<ocr-content>\nFirst\nSecond\nThird\n</ocr-content>',
    },
    {
      type: 'image-data',
      data: png.toString('base64'),
      mediaType: 'image/png',
    },
  ]);
  const zoom = await f.read({
    path: 'image.png',
    parameters: { image_zoom: { x: 0, y: 0, w: 1, h: 1, scale: 3 } },
  });
  assert.match(JSON.stringify(zoom.blocks[1]), /Dimensions: 3 x 3 pixels/);
  assert.match(
    JSON.stringify(zoom.blocks[1]),
    new RegExp(`Size: ${zoom.result.size} bytes`),
  );
});

test('PDF fallback retains page metadata and labels local text without OCR tags', async (t) => {
  const f = await fixture(t, false);
  const { result, blocks } = await f.read({
    path: 'report.pdf',
    parameters: { pdf_pages: '2' },
  });
  assert.equal(result.totalPages, 3);
  assert.deepEqual(result.selectedPages, [2]);
  assert.equal(result.textSource, 'pdf-text');
  assert.match(JSON.stringify(blocks[1]), /PDF text layer/);
  assert.deepEqual(blocks[2], { type: 'text', text: result.content[0].text });
  assert.match(result.content[0].text, /TWO/);
  assert.doesNotMatch(JSON.stringify(blocks), /<ocr-content>/);
  assert.deepEqual(blocks[3], { type: 'text', text: result.warnings![0] });
});

test('unreadable PDF page counts remain unknown while provider OCR can still succeed', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'provider-only.pdf'), '%PDF-1.4\n%%EOF');
  const { result, blocks } = await f.read({ path: 'provider-only.pdf' });
  assert.equal(result.totalPages, undefined);
  assert.equal(result.selectedPages, undefined);
  assert.match(JSON.stringify(blocks[1]), /Total pages: unknown/);
  assert.match(JSON.stringify(blocks[2]), /<ocr-content>/);
  assert.match(result.warnings?.join('\n') ?? '', /页码信息不可用/);
});

test('Agent forwards separate text blocks to the next model request', async (t) => {
  const f = await fixture(t);
  const expected = (await f.read({ path: 'report.pdf' })).blocks;
  let requests = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }) => {
      const step = ++requests;
      if (step === 2) {
        const result = prompt
          .flatMap((message) =>
            message.role === 'tool' ? message.content : [],
          )
          .find(
            (part) =>
              part.type === 'tool-result' && part.toolName === 'read_file',
          );
        assert.ok(result);
        assert.deepEqual(result.output, { type: 'content', value: expected });
      }
      assert.ok(step <= 2);
      return {
        stream: new ReadableStream({
          start(controller) {
            if (step === 1)
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'read-pdf',
                toolName: 'read_file',
                input: '{"path":"report.pdf"}',
              });
            else {
              controller.enqueue({ type: 'text-start', id: 'answer' });
              controller.enqueue({
                type: 'text-delta',
                id: 'answer',
                delta: 'Read',
              });
              controller.enqueue({ type: 'text-end', id: 'answer' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: step === 1 ? 'tool-calls' : 'stop',
              usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
            });
            controller.close();
          },
        }),
      };
    },
  });
  const agent = new Agent({
    id: 'read-file-output',
    name: 'Read file output',
    instructions: 'Read report.pdf.',
    model,
    tools: { read_file: f.tool },
    workspace: f.workspace,
  });
  const response = await agent.stream('Read the PDF.', { maxSteps: 2 });
  await response.consumeStream();
  assert.equal(await response.text, 'Read');
  assert.equal(requests, 2);
});
