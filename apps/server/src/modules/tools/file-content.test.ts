import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import {
  Workspace,
  LocalFilesystem,
  CompositeFilesystem,
} from '@mastra/core/workspace';
import { noopObserve, isValidationError } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { RequestContext } from '@mastra/core/request-context';
import { parseViewFileOutput } from '../../../../web/src/components/chat/message-preview/view-file-output.js';
import { readFileBlocks } from '../../../../web/src/components/chat/message-preview/read-file-output.js';
import { defaultReadFileConfig } from '@aime/shared/tools';
import { createReadFileTool } from '../../mastra/tools/read_file.js';
import { createExtractTool } from '../../mastra/tools/extract.js';
import { parseFileContent } from '../files/content/parse.js';
import { readFileContent } from '../files/content/source.js';
import { FileContentError } from '../files/content/types.js';
import { readExtractionSource } from './extract/source.js';
import { parseKnowledgeSource } from '../knowledge/parse.js';
import { buildTools } from './registry.js';
import type { AudioService } from '../audio/service.js';
import {
  documentFixture,
  spreadsheetFixture,
  presentationFixture,
  pdfFixture,
  wavFixture,
} from './file-content-fixtures.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j01sAAAAASUVORK5CYII=',
  'base64',
);
async function workspace(t: test.TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'file-content-')),
  );
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace };
}

test('Office bytes become complete Markdown with headings, merged cells, all worksheets and slides', async () => {
  const doc = await parseFileContent({
    fileName: 'sample.docx',
    data: documentFixture(),
  });
  assert.equal(doc.type, 'text');
  if (doc.type !== 'text') return;
  assert.equal(doc.format, 'markdown');
  assert.match(doc.text, /^# 项目概况/m);
  assert.match(doc.text, /^## 费用明细/m);
  assert.match(doc.text, /colspan="2"/i);
  assert.match(doc.text, /123\.45/);
  assert.match(doc.text, /文档末尾 END/);
  for (const [fileName, data, terms] of [
    [
      'sample.xlsx',
      spreadsheetFixture(),
      ['收入', '支出', '最后一行 1', '最后一行 2', '246'],
    ],
    [
      'sample.pptx',
      presentationFixture(),
      ['幻灯片 1 完整内容', '幻灯片 2 完整内容'],
    ],
    [
      'sample.rtf',
      Buffer.from('{\\rtf1\\ansi Complete document}'),
      ['Complete document'],
    ],
  ] as const) {
    const result = await parseFileContent({ fileName, data });
    assert.equal(result.type, 'text');
    if (result.type === 'text')
      for (const term of terms)
        assert.ok(result.text.includes(term), `${fileName}: ${term}`);
  }
});

test('shared conversion has no tool output limit; read_file ranges resume without losing text; extract gets the tail', async (t) => {
  const w = await workspace(t);
  const data = documentFixture(
    Array.from(
      { length: 2200 },
      (_, i) => `paragraph ${i} ${'正文'.repeat(30)}`,
    ),
  );
  await writeFile(join(w.directory, 'long.docx'), data);
  const full = await readFileContent(
    { path: 'long.docx' },
    { filesystem: w.workspace.filesystem },
  );
  assert.equal(full.type, 'text');
  if (full.type !== 'text') return;
  assert.ok(full.text.length > 100_000);
  assert.match(full.text, /文档末尾 END/);
  const tool = createReadFileTool();
  const pieces: string[] = [];
  let offset: number | undefined;
  do {
    const part = await tool.execute!(
      { path: 'long.docx', showLineNumbers: false, offset },
      { workspace: w.workspace, observe: noopObserve },
    );
    assert.ok(
      part &&
        !isValidationError(part) &&
        typeof part === 'object' &&
        'ok' in part &&
        part.ok,
    );
    assert.ok(part.content[0]!.text.length <= 100_000);
    pieces.push(part.content[0]!.text);
    offset = part.nextOffset;
    if (offset)
      assert.match(
        JSON.stringify(await tool.toModelOutput!(part)),
        new RegExp(`offset=${offset}`),
      );
  } while (offset);
  assert.equal(pieces.join('\n'), full.text);
  const messages = await readExtractionSource(
    'long.docx',
    w.workspace.filesystem,
    { modalitiesInput: ['text'] },
    new AbortController().signal,
    {},
  );
  assert.ok('content' in messages[0]!);
  assert.equal(messages[0].content, full.text);
  const huge = '正文'.repeat(500_001);
  const unlimited = await parseFileContent({
    fileName: 'huge.txt',
    data: Buffer.from(huge),
  });
  assert.ok(unlimited.type === 'text' && unlimited.text === huge);
});

test('PDF always becomes Markdown, supports page selection and requires OCR for scans', async (t) => {
  const w = await workspace(t);
  const data = pdfFixture();
  await writeFile(join(w.directory, 'report.pdf'), data);
  const tool = createReadFileTool();
  const context = { workspace: w.workspace, observe: noopObserve };
  const result = await tool.execute!(
    { path: 'report.pdf', showLineNumbers: false },
    context,
  );
  assert.ok(
    result &&
      !isValidationError(result) &&
      typeof result === 'object' &&
      'ok' in result &&
      result.ok,
  );
  assert.match(result.content[0]!.text, /First page content/);
  assert.match(result.content[0]!.text, /Last page END/);
  const selected = await parseFileContent(
    { fileName: 'report.pdf', data },
    {
      model: { modalitiesInput: ['text', 'image', 'pdf'] },
      parameters: { pdf_pages: '2' },
    },
  );
  assert.equal(selected.format, 'markdown');
  assert.match(selected.text, /Last page END/);
  assert.doesNotMatch(selected.text, /First page content/);
  assert.equal(selected.images, undefined);
  await assert.rejects(
    parseFileContent({ fileName: 'scan.pdf', data: pdfFixture(['']) }),
    /扫描文档需要/,
  );
});

test('image media and OCR share validation and only consumers impose truncation', async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.directory, 'image.png'), png);
  const text = '# OCR\n' + 'text\n'.repeat(250_000) + 'END';
  const resolved = {
    reference: 'mock/ocr',
    model: {
      provider: 'mock',
      modelId: 'ocr',
      doOCR: async () => ({ markdown: text, taskId: 'task' }),
    },
  };
  const full = await parseFileContent(
    { fileName: 'image.png', data: png },
    { model: { modalitiesInput: ['text', 'image'] } },
    { resolveOcr: async () => resolved },
  );
  assert.ok(full.type === 'text' && full.text === text);
  assert.deepEqual(Buffer.from(full.images![0]!.data, 'base64'), png);
  const tool = createReadFileTool(defaultReadFileConfig, {
    resolveModel: async () => resolved,
    resolveCurrentModel: async () => ({ modalitiesInput: ['text', 'image'] }),
  });
  const result = await tool.execute!(
    { path: 'image.png', showLineNumbers: false },
    { workspace: w.workspace, observe: noopObserve },
  );
  assert.ok(
    result &&
      !isValidationError(result) &&
      typeof result === 'object' &&
      'ok' in result &&
      result.ok,
  );
  assert.ok(result.truncated);
  assert.ok(result.content[0].text.startsWith('# OCR'));
  assert.equal(result.content[1]!.type, 'image');
  assert.deepEqual(Buffer.from(result.content[1]!.data, 'base64'), png);
  const modelOutput = await tool.toModelOutput!(result);
  assert.ok(
    modelOutput &&
      typeof modelOutput === 'object' &&
      'type' in modelOutput &&
      modelOutput.type === 'content' &&
      'value' in modelOutput &&
      Array.isArray(modelOutput.value),
  );
  assert.deepEqual(modelOutput.value[1], {
    type: 'image-data',
    data: png.toString('base64'),
    mediaType: 'image/png',
  });
  assert.equal(parseViewFileOutput(result)?.text, result.content[0].text);
  assert.equal(
    readFileBlocks(result).filter((block) => block.type === 'media').length,
    1,
  );
  const withoutOcr = await parseFileContent(
    { fileName: 'image.png', data: png },
    { model: { modalitiesInput: ['image'] } },
  );
  assert.equal(withoutOcr.text, '');
  assert.ok(withoutOcr.images?.length && withoutOcr.warnings?.length);
  const textOnly = await parseFileContent(
    { fileName: 'image.png', data: png },
    { model: { modalitiesInput: ['text'] } },
    { resolveOcr: async () => resolved },
  );
  assert.equal(textOnly.text, text);
  assert.equal(textOnly.images, undefined);
  await assert.rejects(
    parseFileContent(
      { fileName: 'invalid.png', data: Buffer.from('bad') },
      { model: { modalitiesInput: ['image'] } },
    ),
  );
});

test('read_file and extract use the same persisted ASR model and the complete transcription', async (t) => {
  const w = await workspace(t);
  const wav = wavFixture();
  await writeFile(join(w.directory, 'meeting.wav'), wav);
  const transcript =
    '会议记录\n' + '讨论内容\n'.repeat(25_000) + '会议结束 END';
  const selected: (string | undefined)[] = [];
  const audio = {
    transcriptions: async (data: Buffer, options: { model?: string }) => {
      assert.deepEqual(data, wav);
      selected.push(options.model);
      return { text: transcript };
    },
  } as unknown as AudioService;
  const model = new MastraLanguageModelV2Mock({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '{"end":"END"}' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
  const tools = await buildTools(
    ['read_file', 'extract'],
    { extract: { mode: 'fast' } },
    {
      audio,
      loadConfig: async (id) =>
        id === 'transcriptions' ? { model: 'asr/saved' } : {},
      extractionModel: async () => ({
        reference: 'mock/text',
        model,
        modalitiesInput: ['text'],
      }),
    },
  );
  const read = await (tools.read_file as ReturnType<typeof createReadFileTool>)
    .execute!(
    { path: 'meeting.wav', showLineNumbers: false },
    { workspace: w.workspace, observe: noopObserve },
  );
  assert.ok(
    read && typeof read === 'object' && 'truncated' in read && read.truncated,
  );
  const extract = await (tools.extract as ReturnType<typeof createExtractTool>)
    .execute!(
    {
      source: 'meeting.wav',
      fields:
        '{"type":"object","properties":{"end":{"type":"string"}},"required":["end"]}',
    },
    { workspace: w.workspace, observe: noopObserve },
  );
  assert.equal(typeof extract, 'string');
  assert.match(
    JSON.stringify(model.doGenerateCalls[0]!.prompt),
    /会议结束 END/,
  );
  assert.deepEqual(selected, ['asr/saved', 'asr/saved']);
  const video = await parseFileContent(
    { fileName: 'meeting.mp4', data: Buffer.from('fixture') },
    {},
    { transcribe: async () => transcript },
  );
  assert.ok(
    video.type === 'text' &&
      video.kind === 'video' &&
      video.text === transcript,
  );
});

test('complete parser and read_file return promptly on ignored cancellation and sanitize ASR failures', async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.directory, 'meeting.wav'), wavFixture());
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const tool = createReadFileTool(defaultReadFileConfig, {
    transcribe: async () => {
      started();
      return new Promise(() => {});
    },
  });
  const pending = tool.execute!(
    { path: 'meeting.wav', showLineNumbers: false },
    {
      workspace: w.workspace,
      observe: noopObserve,
      abortSignal: controller.signal,
    },
  );
  await ready;
  controller.abort();
  const result = await Promise.race([
    pending,
    delay(300).then(() => 'too late'),
  ]);
  assert.ok(
    result &&
      !isValidationError(result) &&
      typeof result === 'object' &&
      'ok' in result &&
      !result.ok,
  );
  assert.equal(result.content[0]!.text, '用户中止了操作');
  await assert.rejects(
    parseFileContent(
      { fileName: 'audio.wav', data: wavFixture() },
      {},
      {
        transcribe: async () => {
          throw new Error('secret-provider-key');
        },
      },
    ),
    (error: unknown) =>
      error instanceof FileContentError &&
      error.code === 'ASR_FAILED' &&
      !error.message.includes('secret-provider-key'),
  );
});

test('knowledge uses the same complete Markdown conversion and keeps its own chunk limits', async () => {
  const data = documentFixture();
  const full = await parseFileContent({ fileName: 'source.docx', data });
  const knowledge = await parseKnowledgeSource({
    sourceType: 'file',
    name: 'source.docx',
    sourceData: data,
    sourceUrl: null,
  });
  assert.ok(full.type === 'text');
  assert.equal(knowledge.content, full.text.trim());
  assert.ok(knowledge.texts.length > 0);
});

test('converted documents obey composite workspace symlink boundaries before parsing', async (t) => {
  const w = await workspace(t);
  await symlink('/etc/passwd', join(w.directory, 'escape.docx'));
  const mounted = new Workspace({
    filesystem: new CompositeFilesystem({
      mounts: { '/local': w.workspace.filesystem! },
    }),
  });
  await mounted.init();
  t.after(() => mounted.destroy());
  await assert.rejects(
    readFileContent(
      { path: '/local/escape.docx' },
      { filesystem: mounted.filesystem },
    ),
    /outside/,
  );
  const read = await createReadFileTool().execute!(
    { path: '/local/escape.docx', showLineNumbers: false },
    { workspace: mounted, observe: noopObserve },
  );
  assert.ok(
    read &&
      !isValidationError(read) &&
      typeof read === 'object' &&
      'code' in read &&
      read.code === 'FILE_FORBIDDEN',
  );
});

test('URL input follows validated redirects and detects extensionless Office downloads by MIME', async () => {
  const previous = process.env.ALLOW_ALL_NETWORKS;
  const data = documentFixture();
  const server = createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/download' });
      res.end();
    } else {
      res.writeHead(200, {
        'content-type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      res.end(data);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/start`;
    process.env.ALLOW_ALL_NETWORKS = 'false';
    await assert.rejects(readFileContent({ path: url }));
    process.env.ALLOW_ALL_NETWORKS = 'true';
    const result = await readFileContent({ path: url });
    assert.ok(result.type === 'text' && result.text.includes('# 项目概况'));
  } finally {
    if (previous === undefined) delete process.env.ALLOW_ALL_NETWORKS;
    else process.env.ALLOW_ALL_NETWORKS = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('flat files preserve the original UTF-8 text including HTML, BOM and line endings', async () => {
  assert.equal(
    (await parseFileContent({ fileName: 'empty.txt', data: Buffer.alloc(0) }))
      .text,
    '',
  );
  for (const fileName of [
    'source.txt',
    'source.html',
    'source.md',
    'source.csv',
  ]) {
    const text = '\ufeff<h1>原文</h1>\r\n  original text  \r\n';
    const result = await parseFileContent({
      fileName,
      data: Buffer.from(text),
    });
    assert.equal(result.text, text);
    assert.equal(result.images, undefined);
  }
});

test('Excel samples preserve coordinates and selections; extract and knowledge explicitly request all rows', async (t) => {
  const w = await workspace(t);
  const input = { fileName: 'book.xlsx', data: spreadsheetFixture(25) };
  await writeFile(join(w.directory, input.fileName), input.data);
  const sample = await parseFileContent(input);
  assert.equal(sample.sheets?.length, 2);
  assert.equal(sample.sheets[0]!.sampled, true);
  assert.equal(sample.sheets[0]!.selectedRows.length, 20);
  assert.equal(sample.sheets[0]!.totalRows, 30);
  assert.doesNotMatch(sample.text, /最后一行/);
  for (const excel_sheet of ['支出', 2]) {
    const selected = await parseFileContent(input, {
      parameters: { excel_sheet, excel_range: 'A30:B30', excel_rows: 'all' },
    });
    assert.equal(selected.sheets?.length, 1);
    assert.deepEqual(selected.sheets[0]!.selectedRows, [30]);
    assert.match(selected.text, /\| 30 \| 最后一行 2/);
    assert.doesNotMatch(selected.text, /收入|样例行/);
  }
  const messages = await readExtractionSource(
    input.fileName,
    w.workspace.filesystem,
    { modalitiesInput: ['text'] },
    new AbortController().signal,
    {},
  );
  assert.match(JSON.stringify(messages), /最后一行 1/);
  assert.match(JSON.stringify(messages), /最后一行 2/);
  const knowledge = await parseKnowledgeSource({
    sourceType: 'file',
    name: input.fileName,
    sourceData: input.data,
    sourceUrl: null,
  });
  assert.match(knowledge.content, /最后一行 2/);
  await assert.rejects(
    parseFileContent(input, { parameters: { excel_sheet: 'missing' } }),
    /未找到指定工作表/,
  );
  await assert.rejects(
    parseFileContent(input, { parameters: { excel_range: 'B20:A1' } }),
    /结束位置/,
  );
});

test('dynamic PDF and PPT selections reach both tools without selecting other pages', async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.directory, 'deck.pptx'), presentationFixture());
  const input = {
    path: 'deck.pptx',
    parameters: { ppt_slides: [2] },
    showLineNumbers: false,
  };
  const result = await createReadFileTool().execute!(input, {
    workspace: w.workspace,
    observe: noopObserve,
  });
  assert.ok(
    result &&
      !isValidationError(result) &&
      typeof result === 'object' &&
      'ok' in result &&
      result.ok,
  );
  assert.match(result.content[0].text, /幻灯片 2 完整内容/);
  assert.doesNotMatch(result.content[0].text, /幻灯片 1 完整内容/);
  await writeFile(join(w.directory, 'report.pdf'), pdfFixture());
  const messages = await readExtractionSource(
    'report.pdf',
    w.workspace.filesystem,
    { modalitiesInput: ['text', 'pdf'] },
    new AbortController().signal,
    {},
    { pdf_pages: '2' },
  );
  assert.match(JSON.stringify(messages), /Last page END/);
  assert.doesNotMatch(JSON.stringify(messages), /First page content/);
  await assert.rejects(
    parseFileContent(
      { fileName: 'report.pdf', data: pdfFixture() },
      { parameters: { pdf_pages: '0' } },
    ),
    /从 1 开始/,
  );
});

test('read_file resolves the current chat model before adding image data, with an explicit opt-out', async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.directory, 'image.png'), png);
  const selected: (string | null)[] = [];
  const tools = await buildTools(
    ['read_file'],
    {},
    {
      fileInputModel: async (reference) => {
        selected.push(reference);
        return {
          reference: reference!,
          modalitiesInput:
            reference === 'chat/vision' ? ['text', 'image'] : ['text'],
        };
      },
      ocrModel: async () => ({
        reference: 'mock/ocr',
        model: {
          provider: 'mock',
          modelId: 'ocr',
          doOCR: async () => ({ markdown: '# OCR text', taskId: 'mock-task' }),
        },
      }),
    },
  );
  const tool = tools.read_file as ReturnType<typeof createReadFileTool>;
  for (const [reference, parameters, imageCount] of [
    ['chat/vision', {}, 1],
    ['chat/text', {}, 0],
    ['chat/vision', { image_base64: false }, 0],
  ] as const) {
    const requestContext = new RequestContext();
    requestContext.set('chatSettings', { model: reference });
    const result = await tool.execute!(
      { path: 'image.png', showLineNumbers: false, parameters },
      { workspace: w.workspace, observe: noopObserve, requestContext },
    );
    assert.ok(
      result &&
        !isValidationError(result) &&
        typeof result === 'object' &&
        'ok' in result &&
        result.ok,
    );
    assert.equal(result.content[0].text, '# OCR text');
    assert.equal(result.content.length, imageCount + 1);
  }
  assert.deepEqual(selected, ['chat/vision', 'chat/text', 'chat/vision']);
});

test('incomplete Office parsing is rejected instead of returning apparently complete Markdown', async () => {
  const files = unzipSync(documentFixture());
  files['word/document.xml'] = strToU8(
    strFromU8(files['word/document.xml']!).replace(
      '</w:body>',
      '<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="missing"/></w:body>',
    ),
  );
  await assert.rejects(
    parseFileContent({ fileName: 'incomplete.docx', data: zipSync(files) }),
    (error: unknown) =>
      error instanceof FileContentError &&
      error.code === 'FILE_PARSE_INCOMPLETE',
  );
});
