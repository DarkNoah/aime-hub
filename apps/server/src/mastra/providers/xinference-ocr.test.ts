import assert from 'node:assert/strict';
import test from 'node:test';
import { XinferenceProvider } from './xinference.js';
import { providerModelTypes, isOcrProvider } from '@aime/shared/providers';
import type { requestWebResource } from '../web/request.js';

const config = {
  id: 'gateway',
  baseUrl: 'https://gateway.example/v1/',
  apiKey: 'test-secret',
};
const input = { data: new Uint8Array([1, 2, 3]), fileName: 'document.pdf' };
const pages = [
  {
    markdown: '# Page 1\n<table><tr><td>123</td></tr></table>',
    crop_blocks: [{ content: '123', bbox: [0, 1, 2, 3] }],
  },
  { markdown: 'Page 2', source: { page_index: 1 } },
];
const response = (
  body: string,
  contentType = 'application/json',
  status = 200,
) => ({
  url: 'https://gateway.example/v1/documents/parse',
  status,
  headers: { 'content-type': contentType },
  body: Buffer.from(body),
});

test('Xinference supports OCR alongside language models', () => {
  assert.ok(providerModelTypes('xinference').includes('ocr'));
  assert.ok(providerModelTypes('xinference').includes('language'));
  assert.equal(isOcrProvider('xinference'), false);
});

for (const fileName of ['document.pdf', 'photo.png', 'scan.jpg', 'scan.tiff']) {
  test(`Xinference uploads ${fileName}, retains JSON and joins page Markdown`, async () => {
    const request: typeof requestWebResource = async (url, options) => {
      assert.equal(url, 'https://gateway.example/v1/documents/parse');
      assert.equal(options?.headers?.authorization, 'Bearer test-secret');
      const form = await new Response(new Uint8Array(options!.body as Buffer), {
        headers: options!.headers as Record<string, string>,
      }).formData();
      assert.equal(form.get('model'), null);
      assert.equal(form.get('response_format'), 'json');
      const file = form.get('file') as File;
      assert.equal(file.name, fileName);
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), input.data);
      return response(JSON.stringify(pages));
    };
    const result = await new XinferenceProvider(config, request)
      .ocrModel('document-ocr')
      .doOCR({ input: { ...input, fileName }, responseFormat: 'json' });
    assert.equal(
      result.markdown,
      pages.map((page) => page.markdown).join('\n\n'),
    );
    assert.deepEqual(result.data, pages);
  });
}

test('Default Markdown format and URL downloads do not leak credentials', async () => {
  let calls = 0;
  const request: typeof requestWebResource = async (url, options) => {
    if (++calls === 1) {
      assert.equal(url, 'https://files.example/scan.pdf');
      assert.equal(options?.headers?.authorization, undefined);
      return response('pdf bytes', 'application/pdf');
    }
    const form = await new Response(new Uint8Array(options!.body as Buffer), {
      headers: options!.headers as Record<string, string>,
    }).formData();
    assert.equal(form.get('response_format'), 'md');
    return response('# Recognized document', 'text/markdown');
  };
  const result = await new XinferenceProvider(config, request)
    .ocrModel('ocr')
    .doOCR({
      input: { url: 'https://files.example/scan.pdf' },
    });
  assert.equal(result.markdown, '# Recognized document');
  assert.equal(calls, 2);
});

test('invalid responses, HTTP failures and cancellation are rejected', async () => {
  for (const reply of [
    response('broken'),
    response('{"error":"bad"}'),
    response('test-secret', 'text/plain', 500),
  ]) {
    const model = new XinferenceProvider(config, async () => reply).ocrModel(
      'ocr',
    );
    await assert.rejects(
      model.doOCR({ input, responseFormat: 'json' }),
      (error: Error) => !error.message.includes('test-secret'),
    );
  }
  const model = new XinferenceProvider(config, async () => {
    throw new Error('must not request');
  }).ocrModel('ocr');
  await assert.rejects(
    model.doOCR({ input, abortSignal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  await assert.rejects(
    model.doOCR({ input, pageRanges: '1' }),
    /does not support/,
  );
  await assert.rejects(
    model.doOCR({ input: { ...input, data: new Uint8Array() } }),
    /non-empty/,
  );
});

test('model discovery recognizes OCR without treating it as a language model', async () => {
  const provider = new XinferenceProvider(config, async () =>
    response(
      JSON.stringify({
        data: [
          { id: 'document-ocr', model_type: 'OCR' },
          { id: 'chat', model_type: 'LLM' },
        ],
      }),
    ),
  );
  assert.deepEqual(
    (await provider.getOcrModelList()).map(
      ({ id, modelType, modalitiesInput, modalitiesOutput }) => ({
        id,
        modelType,
        modalitiesInput,
        modalitiesOutput,
      }),
    ),
    [
      {
        id: 'document-ocr',
        modelType: 'ocr',
        modalitiesInput: ['pdf', 'image'],
        modalitiesOutput: ['text'],
      },
    ],
  );
  assert.deepEqual(
    (await provider.getLanguageModelList()).map((model) => model.id),
    ['chat'],
  );
  assert.equal(providerModelTypes('newapi').includes('ocr'), false);
});

test('Xinference OCR supports deployments without an API key', async () => {
  const provider = new XinferenceProvider(
    { ...config, apiKey: undefined },
    async (_url, options) => {
      assert.equal(options.headers?.authorization, undefined);
      return response('# Invoice', 'text/markdown');
    },
  );
  const model = provider.ocrModel('ocr');
  assert.equal(model.provider, 'xinference');
  await model.doOCR({ input });
});

test('MiniCPM OCR image capability is discovered as OCR; ordinary image models are retained', async () => {
  const provider = new XinferenceProvider(config, async () =>
    response(
      JSON.stringify({
        data: [
          {
            id: 'MiniCPM-OCR-1.0',
            model_name: 'MiniCPM-OCR-1.0',
            model_type: 'image',
            model_ability: ['ocr'],
          },
          {
            id: 'image-generator',
            model_type: 'image',
            model_ability: ['text2image'],
          },
        ],
      }),
    ),
  );
  const models = await provider.getModelList();
  assert.equal(models.length, 2);
  const ocr = models.find((model) => model.id === 'MiniCPM-OCR-1.0')!;
  assert.equal(ocr.modelType, 'ocr');
  assert.deepEqual(ocr.modalitiesInput, ['pdf', 'image']);
  assert.deepEqual(ocr.modalitiesOutput, ['text']);
  assert.ok(models.some((model) => model.id === 'image-generator'));
  assert.equal((await provider.getOcrModelList()).length, 1);
  assert.deepEqual(await provider.getLanguageModelList(), []);
});

test('unknown and absent model types remain discoverable with original capability metadata', async () => {
  const provider = new XinferenceProvider(config, async () =>
    response(
      JSON.stringify({
        data: [
          {
            id: 'future-model',
            model_type: 'new-custom-type',
            model_ability: ['custom-task'],
          },
          { id: 'untyped-model' },
          { id: 'null-type-model', model_type: null },
        ],
      }),
    ),
  );
  const models = await provider.getModelList();
  assert.deepEqual(
    models.map((model) => model.id),
    ['future-model', 'null-type-model', 'untyped-model'],
  );
  assert.deepEqual(models[0].metadata, {
    xinference: {
      model_type: 'new-custom-type',
      model_ability: ['custom-task'],
    },
  });
  for (const model of models) {
    assert.equal(model.modelType, undefined);
    assert.deepEqual(model.modalitiesInput, []);
    assert.deepEqual(model.modalitiesOutput, []);
  }
});
