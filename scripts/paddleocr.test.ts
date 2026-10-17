import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOcrProvider,
  modelInputSchema,
  modelSupportsType,
  providerGroup,
  providerInputSchema,
  providerModelTypes,
  providerSupportsModels,
} from '@aime/shared/providers';
import { PaddleOCRProvider } from '../apps/server/src/mastra/providers/paddleocr.js';
import type { OcrInput } from '../apps/server/src/mastra/providers/ocr-model.js';
import type {
  WebResource,
  requestWebResource,
} from '../apps/server/src/mastra/web/request.js';
import { modelOptions } from '../apps/web/src/components/model-selector/model-options.js';

const config = {
  id: 'paddle',
  baseUrl: 'https://paddleocr.aistudio-app.com',
  apiKey: 'synthetic-paddleocr-token',
};
const sourceUrl = 'https://files.example.test/document.pdf';
const resultUrl = 'https://cdn.example.test/result.jsonl';
const jobsUrl = `${config.baseUrl}/api/v2/ocr/jobs`;

test('self-hosted layout-parsing exposes only the deployed model and uses synchronous base64 input without a token', async () => {
  const { request, calls } = fixture([
    { logId: 'sync-image', errorCode: 0, ...documentLine('# Invoice 12345') },
  ]);
  const provider = new PaddleOCRProvider(
    { id: 'local', baseUrl: 'https://ocr.example/layout-parsing/' },
    request,
  );
  assert.deepEqual(
    (await provider.getModelList()).map(({ id }) => id),
    ['PaddleOCR-VL'],
  );
  assert.throws(() => provider.ocrModel('PP-OCRv5'));
  const model = provider.ocrModel('PaddleOCR-VL');
  assert.equal(model.supportsPageRanges, false);
  assert.deepEqual(
    await model.doOCR({
      input: { data: Buffer.from('png-bytes'), fileName: 'receipt.png' },
    }),
    { markdown: '# Invoice 12345', taskId: 'sync-image' },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://ocr.example/layout-parsing');
  assert.equal(calls[0][1]?.headers?.authorization, undefined);
  assert.deepEqual(JSON.parse(String(calls[0][1]?.body)), {
    file: Buffer.from('png-bytes').toString('base64'),
    fileType: 1,
    returnMarkdownImages: false,
    visualize: false,
  });
});

test('layout-parsing handles PDFs and URLs, propagates cancellation and rejects unsupported options before posting', async () => {
  const { request, calls } = fixture([
    {
      logId: 'pdf',
      errorCode: 0,
      result: {
        layoutParsingResults: [
          { markdown: { text: 'Page 1' } },
          { markdown: { text: 'Page 2' } },
        ],
      },
    },
    { logId: 'url', errorCode: 0, ...documentLine('URL text') },
  ]);
  const provider = new PaddleOCRProvider(
    { id: 'local', baseUrl: 'https://ocr.example/layout-parsing' },
    request,
  );
  const model = provider.ocrModel('PaddleOCR-VL');
  const input = { data: Buffer.from('%PDF-1.4'), fileName: 'document.PDF' };
  assert.equal(
    (
      await model.doOCR({
        input,
        providerOptions: { useChartRecognition: false },
      })
    ).markdown,
    'Page 1\n\nPage 2',
  );
  assert.equal(JSON.parse(String(calls[0][1]?.body)).fileType, 0);
  await model.doOCR({ input: { url: sourceUrl } });
  assert.equal(JSON.parse(String(calls[1][1]?.body)).file, sourceUrl);
  assert.equal(JSON.parse(String(calls[1][1]?.body)).fileType, undefined);
  await assert.rejects(
    model.doOCR({ input, pageRanges: '1' }),
    /does not support/,
  );
  await assert.rejects(
    model.doOCR({ input, providerOptions: { unknown: true } }),
  );
  await assert.rejects(
    model.doOCR({
      input: { data: Buffer.from('x'), fileName: '../escape.png' },
    }),
    /file name/,
  );
  await assert.rejects(
    model.doOCR({ input, abortSignal: AbortSignal.abort() }),
  );
  assert.equal(calls.length, 2);
});

test('layout-parsing validates official error envelopes and response shape', async () => {
  for (const response of [
    { logId: 'failure', errorCode: 500, errorMsg: 'synthetic-paddleocr-token' },
    { logId: 'missing', errorCode: 0, result: {} },
    { logId: 'empty', errorCode: 0, result: { layoutParsingResults: [] } },
    { code: 0, data: {} },
  ]) {
    const { request } = fixture([response]);
    const model = new PaddleOCRProvider(
      { ...config, baseUrl: 'https://ocr.example/layout-parsing' },
      request,
    ).ocrModel('PaddleOCR-VL');
    await assert.rejects(
      model.doOCR({ input: { url: sourceUrl } }),
      (error: Error) => !error.message.includes(config.apiKey),
    );
  }
});
const created = { code: 0, data: { jobId: 'job/id' } };
const done = {
  code: 0,
  data: { state: 'done', resultUrl: { jsonUrl: resultUrl } },
};
const documentLine = (text = '# 文档', images?: Record<string, string>) => ({
  result: { layoutParsingResults: [{ markdown: { text, images } }] },
});
const jsonl = (...lines: unknown[]): Partial<WebResource> => ({
  body: Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n')),
});

function fixture(responses: unknown[], timeoutMs?: number) {
  const calls: Parameters<typeof requestWebResource>[] = [];
  const request: typeof requestWebResource = async (...args) => {
    calls.push(args);
    assert.ok(responses.length, 'Unexpected request');
    const next = responses.shift();
    return {
      url: args[0],
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(next)),
      ...(next && typeof next === 'object' && 'body' in next
        ? (next as Partial<WebResource>)
        : {}),
    };
  };
  return {
    calls,
    request,
    provider: new PaddleOCRProvider({ ...config, timeoutMs }, request),
  };
}

test('PaddleOCR exposes official models as OCR only, with offline discovery', async () => {
  const { provider, calls } = fixture([]);
  const models = await provider.getModelList();
  assert.deepEqual(
    models.map(({ id }) => id),
    [
      'PP-OCRv5',
      'PP-OCRv5-latin',
      'PP-OCRv6',
      'PP-StructureV3',
      'PaddleOCR-VL',
      'PaddleOCR-VL-1.5',
      'PaddleOCR-VL-1.6',
    ],
  );
  assert.deepEqual(await provider.getOcrModelList(), models);
  assert.deepEqual(await provider.getLanguageModelList(), []);
  assert.equal(calls.length, 0);
  assert.throws(() => provider.ocrModel('unknown'));
  assert.throws(() => provider.languageModel('PaddleOCR-VL'), /not supported/);
  assert.equal(
    providerInputSchema.parse({
      name: 'PaddleOCR',
      type: 'paddleocr',
      baseUrl: config.baseUrl,
    }).type,
    'paddleocr',
  );
  assert.equal(providerGroup('paddleocr'), 'other');
  assert.equal(providerSupportsModels('paddleocr'), true);
  assert.equal(isOcrProvider('paddleocr'), true);
  assert.deepEqual(providerModelTypes('paddleocr'), ['ocr']);
  const model = modelInputSchema.parse(models[0]);
  assert.equal(modelSupportsType(model, 'language'), false);
  assert.equal(modelSupportsType(model, 'ocr'), true);
  const providers = [
    {
      id: 'paddle',
      name: 'PaddleOCR',
      type: 'paddleocr',
      enabled: true,
      models: [{ ...model, providerId: 'paddle' }],
    },
  ];
  assert.equal(
    modelOptions(providers, providers[0]!.models, 'language').length,
    0,
  );
  assert.equal(modelOptions(providers, providers[0]!.models, 'ocr').length, 1);
});

test('official URL job uses Bearer auth, page ranges and optionalPayload; JSONL pages retain images', async () => {
  const { provider, calls } = fixture([
    created,
    done,
    jsonl(
      documentLine('# 第一页\n![](imgs/a.jpg)', {
        'imgs/a.jpg': 'https://cdn.example.test/one.jpg',
      }),
      documentLine('# 第二页\n![](imgs/a.jpg)', {
        'imgs/a.jpg': 'https://cdn.example.test/two.jpg',
      }),
    ),
  ]);
  const result = await provider.ocrModel('PP-StructureV3').doOCR({
    input: { url: sourceUrl },
    pageRanges: '1-2',
    enableFormula: false,
    enableTable: true,
    providerOptions: { useDocUnwarping: false },
  });
  assert.deepEqual(result, {
    taskId: 'job/id',
    resultUrl,
    markdown:
      '# 第一页\n![](<https://cdn.example.test/one.jpg>)\n\n# 第二页\n![](<https://cdn.example.test/two.jpg>)',
  });
  assert.deepEqual(
    calls.map(([url]) => url),
    [jobsUrl, `${jobsUrl}/job%2Fid`, resultUrl],
  );
  assert.equal(calls[0]![1].method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]![1].body)), {
    model: 'PP-StructureV3',
    fileUrl: sourceUrl,
    pageRanges: '1-2',
    optionalPayload: {
      useDocUnwarping: false,
      useFormulaRecognition: false,
      useTableRecognition: true,
    },
  });
  assert.equal(calls[0]![1].headers?.authorization, `Bearer ${config.apiKey}`);
  assert.equal(calls[1]![1].headers?.authorization, `Bearer ${config.apiKey}`);
  assert.equal(calls[2]![1].headers, undefined);
});

test('local files use official multipart fields and preserve the supplied byte slice', async () => {
  const f = fixture([created, done, jsonl(documentLine())]);
  const bytes = new Uint8Array([0, 37, 80, 68, 70, 0]).subarray(1, 5);
  await new PaddleOCRProvider({ ...config, baseUrl: `${jobsUrl}/` }, f.request)
    .ocrModel('PaddleOCR-VL-1.6')
    .doOCR({
      input: { data: bytes, fileName: 'scan.pdf' },
      pageRanges: '2',
      providerOptions: { useLayoutDetection: true, prettifyMarkdown: false },
    });
  const [url, request] = f.calls[0]!;
  assert.equal(url, jobsUrl);
  assert.match(
    request.headers!['content-type']!,
    /^multipart\/form-data; boundary=/,
  );
  const form = await new Response(new Uint8Array(request.body as Buffer), {
    headers: { 'content-type': request.headers!['content-type']! },
  }).formData();
  assert.equal(form.get('model'), 'PaddleOCR-VL-1.6');
  assert.equal(form.get('pageRanges'), '2');
  assert.deepEqual(JSON.parse(String(form.get('optionalPayload'))), {
    useLayoutDetection: true,
    prettifyMarkdown: false,
  });
  const file = form.get('file') as File;
  assert.equal(file.name, 'scan.pdf');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
});

for (const model of ['PP-OCRv5', 'PP-OCRv5-latin', 'PP-OCRv6']) {
  test(`${model} converts recognized lines and multiple pages to text`, async () => {
    const { provider } = fixture([
      created,
      done,
      jsonl({
        result: {
          ocrResults: [
            {
              prunedResult: {
                rec_texts: ['Hello', '你好'],
                rec_scores: [0.9, 1],
              },
            },
            { prunedResult: { rec_texts: ['第二页'] } },
          ],
        },
      }),
    ]);
    assert.equal(
      (await provider.ocrModel(model).doOCR({ input: { url: sourceUrl } }))
        .markdown,
      'Hello\n你好\n\n第二页',
    );
  });
}

test('blank OCR pages are valid results', async () => {
  const { provider } = fixture([
    created,
    done,
    jsonl({
      result: { ocrResults: [{ prunedResult: { rec_texts: [] } }] },
    }),
  ]);
  assert.equal(
    (await provider.ocrModel('PP-OCRv5').doOCR({ input: { url: sourceUrl } }))
      .markdown,
    '',
  );
});

test('pending jobs poll until done', async () => {
  const { provider, calls } = fixture([
    created,
    { code: 0, data: { state: 'pending', resultUrl: null } },
    done,
    jsonl(documentLine()),
  ]);
  const result = await provider
    .ocrModel('PaddleOCR-VL')
    .doOCR({ input: { url: sourceUrl } });
  assert.equal(result.markdown, '# 文档');
  assert.equal(calls.length, 4);
});

test('invalid configuration, inputs and unsupported shared options fail before network requests', async () => {
  for (const patch of [
    { apiKey: '' },
    { apiKey: 'bad\nkey' },
    { baseUrl: 'https://user:secret@example.test' },
    { baseUrl: 'https://example.test?token=x' },
    { baseUrl: 'ftp://example.test' },
  ])
    assert.throws(() => new PaddleOCRProvider({ ...config, ...patch }));
  const { provider, calls } = fixture([]);
  const model = provider.ocrModel('PaddleOCR-VL');
  const inputs: OcrInput[] = [
    { url: 'file:///etc/passwd' },
    { url: 'https://user:secret@example.test/a.pdf' },
    { data: new Uint8Array(), fileName: 'a.pdf' },
    { data: Buffer.from('x'), fileName: '../a.pdf' },
    { data: Buffer.from('x'), fileName: 'a\n.pdf' },
    { data: Buffer.from('x'), fileName: 'a.exe' },
  ];
  for (const input of inputs) await assert.rejects(model.doOCR({ input }));
  for (const options of [
    { language: 'zh' },
    { forceOcr: false },
    { enableTable: false },
    { enableFormula: true },
  ])
    await assert.rejects(
      model.doOCR({ input: { url: sourceUrl }, ...options }),
    );
  assert.equal(calls.length, 0);
});

test('API and failed-job errors redact the token; HTTP redirects are not followed with credentials', async () => {
  for (const responses of [
    [{ code: 1001, msg: `Rejected ${config.apiKey}` }],
    [
      created,
      {
        code: 0,
        data: { state: 'failed', errorMsg: `Failed ${config.apiKey}` },
      },
    ],
  ]) {
    const { provider } = fixture(responses);
    await assert.rejects(
      provider.ocrModel('PaddleOCR-VL').doOCR({ input: { url: sourceUrl } }),
      (error: Error) => {
        assert.ok(!error.message.includes(config.apiKey));
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
  }
  for (const status of [302, 401, 403, 429, 503]) {
    const { provider, calls } = fixture([
      {
        status,
        headers: { location: resultUrl },
        body: Buffer.from(config.apiKey),
      },
    ]);
    await assert.rejects(
      provider.ocrModel('PP-OCRv5').doOCR({ input: { url: sourceUrl } }),
      new RegExp(`PaddleOCR request failed \\(${status}\\)`),
    );
    assert.equal(calls.length, 1);
  }
});

test('malformed envelopes, states and JSONL never produce a successful empty document', async () => {
  for (const responses of [
    [{ body: Buffer.from('not JSON') }],
    [{}],
    [{ data: {} }],
    [created, { data: { state: 'unknown' } }],
    [created, { data: { state: 'done' } }],
    [created, done, { body: Buffer.from('not JSON') }],
    [created, done, { body: Buffer.alloc(0) }],
    [created, done, jsonl({ result: { layoutParsingResults: [] } })],
    [created, done, jsonl({ result: { layoutParsingResults: [{}] } })],
    [created, done, jsonl(documentLine(), { errorCode: 1 })],
  ])
    await assert.rejects(
      fixture(responses)
        .provider.ocrModel('PaddleOCR-VL')
        .doOCR({ input: { url: sourceUrl } }),
    );
  await assert.rejects(
    fixture([created, done, jsonl(documentLine())])
      .provider.ocrModel('PP-OCRv5')
      .doOCR({ input: { url: sourceUrl } }),
    /Invalid PaddleOCR OCR result/,
  );
});

test('result redirects use bounded requests without the provider token', async () => {
  const redirect = {
    status: 302,
    headers: { location: '/next.jsonl' },
    body: Buffer.alloc(0),
  };
  const { provider, calls } = fixture([
    created,
    done,
    redirect,
    jsonl(documentLine()),
  ]);
  await provider.ocrModel('PaddleOCR-VL').doOCR({ input: { url: sourceUrl } });
  assert.equal(calls[3]![0], 'https://cdn.example.test/next.jsonl');
  assert.ok(calls.slice(2).every(([, options]) => !options.headers));
  assert.equal(calls[2]![1].maxBytes, 20 * 1024 * 1024);
  await assert.rejects(
    fixture([created, done, ...Array(4).fill(redirect)])
      .provider.ocrModel('PaddleOCR-VL')
      .doOCR({ input: { url: sourceUrl } }),
    /Too many/,
  );
  await assert.rejects(
    fixture([
      created,
      {
        data: { state: 'done', resultUrl: { jsonUrl: 'file:///etc/passwd' } },
      },
    ])
      .provider.ocrModel('PaddleOCR-VL')
      .doOCR({ input: { url: sourceUrl } }),
  );
});

test('cancellation and provider timeout apply to submission, polling and result download', async () => {
  const before = new AbortController();
  before.abort(new Error('user cancelled'));
  const f = fixture([]);
  await assert.rejects(
    f.provider.ocrModel('PaddleOCR-VL').doOCR({
      input: { url: sourceUrl },
      abortSignal: before.signal,
    }),
    /user cancelled/,
  );
  assert.equal(f.calls.length, 0);
  for (const cancelAt of [1, 2, 3]) {
    const controller = new AbortController();
    const flow = fixture([created, done, jsonl(documentLine())]);
    const provider = new PaddleOCRProvider(config, async (...args) => {
      const response = await flow.request(...args);
      if (flow.calls.length === cancelAt)
        controller.abort(new Error('stopped'));
      return response;
    });
    await assert.rejects(
      provider.ocrModel('PaddleOCR-VL').doOCR({
        input: { url: sourceUrl },
        abortSignal: controller.signal,
      }),
      /stopped/,
    );
    assert.equal(flow.calls.length, cancelAt);
  }
  const timeout = fixture([created, { data: { state: 'running' } }], 10);
  await assert.rejects(
    timeout.provider
      .ocrModel('PaddleOCR-VL')
      .doOCR({ input: { url: sourceUrl } }),
    { name: 'TimeoutError' },
  );
});
