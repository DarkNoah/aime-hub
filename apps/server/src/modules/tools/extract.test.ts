import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  symlink,
  truncate,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Workspace,
  LocalFilesystem,
  CompositeFilesystem,
} from '@mastra/core/workspace';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { noopObserve, type ToolExecutionContext } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { zipSync, strToU8 } from 'fflate';
import type { DataSource } from 'typeorm';
import { defaultExtractConfig, extractConfigSchema } from '@aime/shared/tools';
import { emptyModelDefaults } from '@aime/shared/providers';
import {
  createExtractTool,
  type ExtractionGeneration,
} from '../../mastra/tools/extract.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import { OpenAICompatibleProvider } from '../../mastra/providers/openai-compatible.js';
import { readExtractionSource } from './extract/source.js';
import { maxBinaryFileBytes } from '../files/binary-file.js';
import { ToolService, buildTools } from './service.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j01sAAAAASUVORK5CYII=',
  'base64',
);
const fields = JSON.stringify({
  type: 'object',
  properties: { name: { type: ['string', 'null'] }, total: { type: 'number' } },
  required: ['name', 'total'],
  additionalProperties: false,
});
const data = { name: '李明', total: 123.45 };
const input = { source: 'invoice.txt', fields };
const config = { ...defaultExtractConfig, mode: 'fast' as const };

async function workspace(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'extract-')));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  await mkdir(join(directory, '.uploads'));
  await writeFile(join(directory, 'invoice.txt'), '姓名：李明\n金额：123.45');
  await writeFile(join(directory, '.uploads/image.png'), png);
  t.after(async () => {
    await workspace.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace };
}

function modelFixture(responses = [JSON.stringify(data)]) {
  let index = 0;
  const model = new MastraLanguageModelV2Mock({
    doGenerate: async () => ({
      content: [
        { type: 'text', text: responses[index++] ?? responses.at(-1)! },
      ],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      warnings: [],
    }),
  });
  return {
    model,
    resolveModel: async () => ({
      reference: 'mock/vision',
      model,
      modalitiesInput: ['text', 'image', 'pdf'],
    }),
  };
}
async function run(
  tool: ReturnType<typeof createExtractTool>,
  args = input,
  context: Partial<ToolExecutionContext> = {},
) {
  const result = await tool.execute!(args, {
    observe: noopObserve,
    ...context,
  });
  assert.equal(typeof result, 'string');
  return result as string;
}

test('extract sends complete UTF-8 content through native Mastra structured output in fast and accurate modes', async (t) => {
  const w = await workspace(t);
  for (const mode of ['fast', 'accurate'] as const) {
    const f = modelFixture(
      mode === 'accurate'
        ? ['姓名：李明，金额：123.45。', JSON.stringify(data)]
        : undefined,
    );
    const tool = createExtractTool({ ...config, mode }, f);
    const result = await run(tool, input, w);
    assert.deepEqual(JSON.parse(result), data);
    assert.equal(f.model.doGenerateCalls.length, mode === 'fast' ? 1 : 2);
    for (const call of f.model.doGenerateCalls)
      assert.match(JSON.stringify(call.prompt), /姓名：李明/);
    assert.deepEqual(await tool.toModelOutput!(result), {
      type: 'text',
      value: result,
    });
  }
});

test('image and PDF bytes reach the native model as media, including uploaded paths', async (t) => {
  const w = await workspace(t);
  const pdf = Buffer.from('%PDF-1.4\n%%EOF');
  await writeFile(join(w.directory, 'scan.pdf'), pdf);
  for (const [source, mime, bytes] of [
    ['/.uploads/image.png', 'image/png', png],
    ['scan.pdf', 'application/pdf', pdf],
  ] as const) {
    const f = modelFixture();
    assert.deepEqual(
      JSON.parse(
        await run(createExtractTool(config, f), { source, fields }, w),
      ),
      data,
    );
    const parts = f.model.doGenerateCalls[0]!.prompt.flatMap((message) =>
      message.role === 'user' ? message.content : [],
    );
    const file = parts.find((part) => part.type === 'file');
    assert.ok(file && file.type === 'file');
    assert.equal(file.mediaType, mime);
    assert.deepEqual(
      typeof file.data === 'string'
        ? Buffer.from(file.data, 'base64')
        : Buffer.from(file.data as Uint8Array),
      bytes,
    );
  }
});

test('text-only models use OCR; DOCX tables and ASR text are extracted without native read truncation', async (t) => {
  const w = await workspace(t);
  const calls: ExtractionGeneration[] = [];
  const f = modelFixture();
  const tool = createExtractTool(config, {
    resolveModel: async () => ({
      ...(await f.resolveModel()),
      modalitiesInput: ['text'],
    }),
    resolveOcr: async () => ({
      model: {
        provider: 'mock',
        modelId: 'ocr',
        doOCR: async ({ input: source }) => {
          assert.deepEqual(source.data, png);
          return {
            markdown: 'OCR 姓名：李明，金额：123.45。',
            taskId: 'test-ocr',
          };
        },
      },
    }),
    transcribe: async () => '语音 姓名：李明，金额：123.45。',
    generate: async (args) => {
      calls.push(args);
      return data;
    },
  });
  await run(tool, { source: '/.uploads/image.png', fields }, w);
  assert.match(JSON.stringify(calls.at(-1)?.messages), /OCR 姓名/);
  const docx = zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>姓名：李明</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>123.45</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    ),
  });
  await writeFile(join(w.directory, 'invoice.docx'), docx);
  await run(tool, { source: 'invoice.docx', fields }, w);
  assert.match(JSON.stringify(calls.at(-1)?.messages), /123\.45/);
  await writeFile(join(w.directory, 'recording.mp4'), 'fixture media');
  await run(tool, { source: 'recording.mp4', fields }, w);
  assert.match(JSON.stringify(calls.at(-1)?.messages), /语音 姓名/);
  await writeFile(
    join(w.directory, 'long.csv'),
    `${'行,内容\n'.repeat(25000)}最后一行,123.45`,
  );
  await run(tool, { source: 'long.csv', fields }, w);
  assert.match(JSON.stringify(calls.at(-1)?.messages), /最后一行/);
});

test('invalid schemas and nonconforming model outputs fail instead of returning unvalidated JSON', async (t) => {
  const w = await workspace(t);
  const f = modelFixture();
  const tool = createExtractTool(config, {
    ...f,
    generate: async () => ({ name: '李明', total: 'wrong' }),
  });
  for (const fields of [
    'invalid',
    'null',
    '[]',
    '{"type":"string"}',
    '{"type":"object","properties":{"name":{"type":"bad"}}}',
  ])
    await assert.rejects(
      run(tool, { source: 'invoice.txt', fields }, w),
      /fields/,
    );
  assert.equal(f.model.doGenerateCalls.length, 0);
  await assert.rejects(run(tool, input, w), /不符合/);
  const array = createExtractTool(config, {
    ...f,
    generate: async () => [data],
  });
  assert.deepEqual(
    JSON.parse(
      await run(
        array,
        {
          source: 'invoice.txt',
          fields: JSON.stringify({ type: 'array', items: JSON.parse(fields) }),
        },
        w,
      ),
    ),
    [data],
  );
});

test('workspace traversal, escaping local mounts, invalid media and oversized input fail before generation', async (t) => {
  const w = await workspace(t);
  let generated = 0;
  const tool = createExtractTool(config, {
    ...modelFixture(),
    generate: async () => {
      generated++;
      return data;
    },
  });
  await symlink('/etc/passwd', join(w.directory, 'escape.txt'));
  await writeFile(join(w.directory, 'invalid.png'), 'not a picture');
  await writeFile(join(w.directory, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(w.directory, 'empty.txt'), '');
  await writeFile(join(w.directory, 'too-long.txt'), 'a'.repeat(1_000_001));
  await writeFile(join(w.directory, 'large.txt'), 'x');
  await truncate(join(w.directory, 'large.txt'), maxBinaryFileBytes + 1);
  for (const source of [
    '../outside.txt',
    '/etc/passwd',
    'escape.txt',
    '.uploads',
    'missing.txt',
    'invalid.png',
    'binary.bin',
    'empty.txt',
    'large.txt',
    'too-long.txt',
  ])
    await assert.rejects(run(tool, { source, fields }, w));
  const composite = new Workspace({
    filesystem: new CompositeFilesystem({
      mounts: { '/local': new LocalFilesystem({ basePath: w.directory }) },
    }),
  });
  await composite.init();
  t.after(() => composite.destroy());
  await assert.rejects(
    run(
      tool,
      { source: '/local/escape.txt', fields },
      { workspace: composite },
    ),
    /权限/,
  );
  assert.equal(generated, 0);
});

test('cancellation returns immediately even if a model ignores its signal, and safe failures omit upstream bodies', async (t) => {
  const w = await workspace(t);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const tool = createExtractTool(config, {
    ...modelFixture(),
    generate: async () => {
      started();
      await new Promise(() => {});
      return data;
    },
  });
  const pending = run(tool, input, { ...w, abortSignal: controller.signal });
  await ready;
  controller.abort();
  assert.equal(
    await Promise.race([pending, delay(300).then(() => 'too late')]),
    '用户中止了操作',
  );
  assert.equal(
    await run(tool, input, { ...w, abortSignal: AbortSignal.abort() }),
    '用户中止了操作',
  );
  const failure = createExtractTool(config, {
    ...modelFixture(),
    generate: async () => {
      throw new Error('api_key=synthetic-secret');
    },
  });
  await assert.rejects(
    run(failure, input, w),
    (error: Error) => !error.message.includes('synthetic-secret'),
  );
  const timeout = createExtractTool(
    { ...config, timeoutMs: 20 },
    { resolveModel: async () => new Promise(() => {}) },
  );
  await assert.rejects(run(timeout, input, w), /超时/);
});

test('registry, persisted configuration, model fallback, disabled tools and exec discoverability use the existing tool system', async (t) => {
  const w = await workspace(t);
  const rows = new Map<string, { value: unknown }>();
  const database = {
    getRepository: () => ({
      findOneBy: async ({ id }: { id: string }) => rows.get(id),
      upsert: async (row: { id: string; value: unknown }) => {
        rows.set(row.id, row);
      },
    }),
  } as unknown as DataSource;
  const f = modelFixture();
  const resolved: string[] = [];
  const providers = {
    getDefaults: async () => ({
      ...emptyModelDefaults,
      defaultModel: 'mock/default',
    }),
    getModel: async (reference: string) => {
      resolved.push(reference);
      return {
        id: reference.split('/')[1],
        providerId: 'mock',
        enabled: reference !== 'mock/disabled',
        modelType: 'language',
        modalitiesInput: ['text', 'image'],
        modalitiesOutput: ['text'],
      };
    },
    getProviderInstance: async () => ({ languageModel: () => f.model }),
  } as unknown as ConstructorParameters<typeof ToolService>[1];
  const service = new ToolService(database, providers);
  assert.deepEqual((await service.get('extract')).config, defaultExtractConfig);
  await service.update('extract', config);
  const requestContext = new RequestContext();
  for (const [model, expected] of [
    [null, 'mock/default'],
    ['mock/chat', 'mock/chat'],
  ] as const) {
    requestContext.set('chatSettings', { model });
    const tools = await service.buildTools(['extract']);
    await run(tools.extract as ReturnType<typeof createExtractTool>, input, {
      ...w,
      requestContext,
    });
    assert.equal(resolved.at(-1), expected);
  }
  await service.update('extract', { ...config, model: 'mock/explicit' });
  await run(
    (await service.buildTools(['extract'])).extract as ReturnType<
      typeof createExtractTool
    >,
    input,
    { ...w, requestContext },
  );
  assert.equal(resolved.at(-1), 'mock/explicit');
  await assert.rejects(
    service.update('extract', { ...config, model: 'mock/disabled' }),
    { code: 'INVALID_EXTRACTION_MODEL' },
  );
  assert.equal(extractConfigSchema.parse({}).mode, 'accurate');
  const tools = await service.buildTools(['exec']);
  const result = await (tools.exec as ReturnType<typeof createExecTool>)
    .execute!(
    {
      code: 'text(ALL_TOOLS.some(t => t.name === "extract"))',
      yield_time_ms: 1000,
      max_output_tokens: 1000,
    },
    { observe: noopObserve, ...w },
  );
  assert.match(JSON.stringify(result), /true/);
  await service.setEnabled('extract', false);
  assert.deepEqual(
    await service.buildTools(['extract'], { extract: { enabled: true } }),
    {},
  );
  assert.deepEqual(
    await buildTools(['extract'], {}, { disabledTools: ['extract'] }),
    {},
  );
});

test('unsupported images without vision/OCR are explicit and source text is never clipped', async (t) => {
  const w = await workspace(t);
  await assert.rejects(
    readExtractionSource(
      '/.uploads/image.png',
      w.workspace.filesystem,
      ['text'],
      AbortSignal.timeout(1000),
      {},
    ),
    /图片抽取需要/,
  );
});

test('native Responses transport serializes images and PDF bytes as input media, never text', async (t) => {
  const w = await workspace(t);
  const pdf = Buffer.from('%PDF-1.4\n%%EOF');
  await writeFile(join(w.directory, 'scan.pdf'), pdf);
  const requests: Record<string, unknown>[] = [];
  const nativeFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    'fetch',
    async (request: string | URL | Request, init?: RequestInit) => {
      if (String(request).startsWith('data:'))
        return nativeFetch(request, init);
      assert.equal(String(request), 'https://extract.example/v1/responses');
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'resp-fixture',
        created_at: 1,
        model: 'vision',
        status: 'completed',
        output: [
          {
            id: 'msg-fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(data),
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      });
    },
  );
  const provider = new OpenAICompatibleProvider({
    id: 'fixture',
    type: 'openai-compatible',
    baseUrl: 'https://extract.example/v1',
    apiKey: 'synthetic',
  });
  const tool = createExtractTool(config, {
    resolveModel: async () => ({
      reference: 'fixture/vision',
      model: provider.languageModel('vision'),
      modalitiesInput: ['text', 'image', 'pdf'],
    }),
  });
  for (const source of ['/.uploads/image.png', 'scan.pdf'])
    assert.deepEqual(JSON.parse(await run(tool, { source, fields }, w)), data);
  const imageBody = JSON.stringify(requests[0]);
  const pdfBody = JSON.stringify(requests[1]);
  assert.match(imageBody, /input_image/);
  assert.ok(
    imageBody.includes(`data:image/png;base64,${png.toString('base64')}`),
  );
  assert.match(pdfBody, /input_file/);
  assert.ok(
    pdfBody.includes(`data:application/pdf;base64,${pdf.toString('base64')}`),
  );
});
