import assert from 'node:assert/strict';
import test from 'node:test';
import {
  embedMany,
  rerank,
  experimental_generateSpeech as generateSpeech,
} from 'ai';
import { XinferenceProvider } from '../apps/server/src/mastra/providers/xinference.js';
import type {
  requestWebResource,
  WebResource,
} from '../apps/server/src/mastra/web/request.js';
import {
  emptyModelDefaults,
  normalizeModelDefaults,
  modelInputSchema,
  modelUpdateSchema,
  modelSupportsType,
} from '@aime/shared/providers';
import { modelOptions } from '../apps/web/src/components/model-selector/model-options.js';

type Request = typeof requestWebResource;
const config = {
  id: 'test',
  baseUrl: 'http://inference.example.test:9997',
  apiKey: 'synthetic-secret',
};
function fixture(response: unknown, overrides: Partial<WebResource> = {}) {
  const calls: Parameters<Request>[] = [];
  const request: Request = async (...args) => {
    calls.push(args);
    return {
      url: args[0],
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(response)),
      ...overrides,
    };
  };
  return { provider: new XinferenceProvider(config, request), calls, request };
}
const modelResponse = {
  data: [
    {
      id: 'embed',
      model_name: 'Embedding',
      model_type: 'embedding',
      max_tokens: 8192,
    },
    { id: 'rank', model_type: 'rerank' },
    {
      id: 'VoxCPM2',
      model_type: 'audio',
      model_ability: ['text2audio', 'text2audio_voice_cloning'],
    },
    { id: 'chat', model_type: 'LLM', model_ability: ['chat', 'vision'] },
    { id: 'whisper', model_type: 'audio', model_ability: ['audio2text'] },
  ],
};

test('Xinference discovers typed models, excludes transcription and normalizes /v1', async () => {
  const { provider, calls, request } = fixture(modelResponse);
  const models = await provider.getModelList();
  assert.deepEqual(
    models.map(({ id, modelType }) => [id, modelType]),
    [
      ['chat', 'language'],
      ['embed', 'embedding'],
      ['rank', 'rerank'],
      ['VoxCPM2', 'speech'],
    ],
  );
  assert.deepEqual(
    models.find((model) => model.id === 'VoxCPM2')?.modalitiesOutput,
    ['audio'],
  );
  assert.deepEqual(
    (await provider.getEmbeddingModelList()).map((model) => model.id),
    ['embed'],
  );
  assert.deepEqual(
    (await provider.getRerankModelList()).map((model) => model.id),
    ['rank'],
  );
  assert.deepEqual(
    (await provider.getSpeechModelList()).map((model) => model.id),
    ['VoxCPM2'],
  );
  assert.deepEqual(
    (await provider.getLanguageModelList()).map((model) => model.id),
    ['chat'],
  );
  await new XinferenceProvider(
    { ...config, baseUrl: `${config.baseUrl}/v1/` },
    request,
  ).getModelList();
  for (const [url, options] of calls) {
    assert.equal(url, `${config.baseUrl}/v1/models`);
    assert.equal(options.headers?.authorization, `Bearer ${config.apiKey}`);
  }
  const chat = provider.languageModel('vendor/chat');
  assert.equal('modelId' in chat && chat.modelId, 'vendor/chat');
});

test('Xinference embeddings work through AI SDK and restore input order', async () => {
  const { provider, calls } = fixture({
    data: [
      { index: 1, embedding: [3, 4] },
      { index: 0, embedding: [1, 2] },
    ],
    usage: { prompt_tokens: 8 },
  });
  const result = await embedMany({
    model: provider.embeddingModel('embed'),
    values: ['first', 'second'],
    providerOptions: { xinference: { dimensions: 2 } },
    maxRetries: 0,
  });
  assert.deepEqual(result.embeddings, [
    [1, 2],
    [3, 4],
  ]);
  assert.equal(result.usage.tokens, 8);
  assert.equal(calls[0][0], `${config.baseUrl}/v1/embeddings`);
  assert.deepEqual(JSON.parse(String(calls[0][1].body)), {
    model: 'embed',
    input: ['first', 'second'],
    encoding_format: 'float',
    dimensions: 2,
  });
  for (const data of [
    [],
    [
      { index: 0, embedding: [1] },
      { index: 0, embedding: [2] },
    ],
    [
      { index: 0, embedding: [1] },
      { index: 2, embedding: [2] },
    ],
  ]) {
    await assert.rejects(
      embedMany({
        model: fixture({ data }).provider.embeddingModel('embed'),
        values: ['a', 'b'],
        maxRetries: 0,
      }),
      /embedding indices/,
    );
  }
});

test('Xinference rerank maps top_n and relevance scores through AI SDK', async () => {
  const { provider, calls } = fixture({
    id: 'ranking-1',
    results: [
      { index: 0, relevance_score: 0.1 },
      { index: 1, relevance_score: 0.9 },
    ],
  });
  const result = await rerank({
    model: provider.rerankingModel('rank'),
    query: 'capital',
    documents: ['apple', 'Beijing'],
    topN: 1,
    maxRetries: 0,
  });
  assert.deepEqual(result.ranking, [
    { originalIndex: 1, score: 0.9, document: 'Beijing' },
  ]);
  assert.deepEqual(JSON.parse(String(calls[0][1].body)), {
    model: 'rank',
    query: 'capital',
    documents: ['apple', 'Beijing'],
    top_n: 1,
    return_documents: false,
  });
  await assert.rejects(
    rerank({
      model: provider.rerankingModel('rank'),
      query: 'q',
      documents: [{ title: 'structured' }],
      maxRetries: 0,
    }),
    /requires text documents/,
  );
  await assert.rejects(
    rerank({
      model: fixture({
        results: [{ index: 4, relevance_score: 1 }],
      }).provider.rerankingModel('rank'),
      query: 'q',
      documents: ['a'],
      maxRetries: 0,
    }),
    /rerank indices/,
  );
});

test('speech defaults to WAV without reference audio; kwargs remains a JSON string', async () => {
  const audio = Buffer.from('RIFF0000WAVEsynthetic-audio');
  const { provider, calls } = fixture(null, {
    headers: { 'content-type': 'audio/wav' },
    body: audio,
  });
  const result = await generateSpeech({
    model: provider.speechModel('VoxCPM2'),
    text: '你好',
    speed: 1.2,
    providerOptions: { xinference: { kwargs: { seed: -1 } } },
    maxRetries: 0,
  });
  assert.deepEqual(Buffer.from(result.audio.uint8Array), audio);
  assert.equal(result.audio.mediaType, 'audio/wav');
  assert.equal(calls[0][0], `${config.baseUrl}/v1/audio/speech`);
  assert.equal(calls[0][1].headers?.['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0][1].body)), {
    model: 'VoxCPM2',
    input: '你好',
    voice: '',
    speed: 1.2,
    response_format: 'wav',
    stream: false,
    kwargs: '{"seed":-1}',
  });
  await generateSpeech({
    model: provider.speechModel('VoxCPM2'),
    text: 'Test',
    outputFormat: 'mp3',
    maxRetries: 0,
  });
  assert.equal(JSON.parse(String(calls[1][1].body)).response_format, 'mp3');
});

test('speech with reference bytes uses multipart and preserves prompt_text', async () => {
  const { provider, calls } = fixture(null, {
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('ID3synthetic'),
  });
  const reference = Buffer.from('RIFFreference');
  await generateSpeech({
    model: provider.speechModel('VoxCPM2'),
    text: 'Test',
    providerOptions: {
      xinference: {
        promptSpeech: reference.toString('base64'),
        kwargs: { prompt_text: 'Reference transcript', seed: 42 },
      },
    },
    maxRetries: 0,
  });
  const [, options] = calls[0];
  assert.match(
    options.headers!['content-type'],
    /^multipart\/form-data; boundary=/,
  );
  const form = await new Response(new Uint8Array(options.body as Buffer), {
    headers: { 'content-type': options.headers!['content-type'] },
  }).formData();
  assert.equal(form.get('model'), 'VoxCPM2');
  assert.equal(form.get('voice'), '');
  assert.equal(form.get('stream'), 'false');
  assert.equal(form.get('response_format'), 'wav');
  assert.deepEqual(JSON.parse(String(form.get('kwargs'))), {
    prompt_text: 'Reference transcript',
    seed: 42,
  });
  const file = form.get('prompt_speech') as File;
  assert.equal(file.type, 'audio/wav');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), reference);
});

test('Xinference validates audio, propagates aborts, and keeps credentials out of errors', async () => {
  for (const response of [
    {
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"error":"upstream"}'),
    },
    { headers: { 'content-type': 'audio/mpeg' }, body: Buffer.alloc(0) },
  ]) {
    await assert.rejects(
      generateSpeech({
        model: fixture(null, response).provider.speechModel('speech'),
        text: 'test',
        maxRetries: 0,
      }),
      /Invalid Xinference audio response/,
    );
  }
  const denied = fixture(null, {
    status: 401,
    body: Buffer.from(config.apiKey),
  });
  await assert.rejects(
    denied.provider.getModelList(),
    (error: Error) => error.message === 'Xinference request failed (401)',
  );
  const { provider, calls } = fixture(null);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    generateSpeech({
      model: provider.speechModel('speech'),
      text: 'test',
      abortSignal: controller.signal,
      maxRetries: 0,
    }),
    /cancelled/,
  );
  assert.equal(calls.length, 0);
  for (const url of [
    'ftp://example.com',
    'https://user:password@example.com',
    'https://example.com?key=secret',
  ])
    assert.throws(() => new XinferenceProvider({ ...config, baseUrl: url }));
});

test('old default settings gain null typed defaults and PATCH preserves model type', () => {
  const old = {
    defaultModel: 'p/chat',
    fastModel: null,
    imageModel: null,
    thinkingMode: 'auto',
  };
  assert.deepEqual(normalizeModelDefaults(old), {
    ...emptyModelDefaults,
    defaultModel: 'p/chat',
  });
  assert.deepEqual(modelUpdateSchema.parse({ name: 'Renamed' }), {
    name: 'Renamed',
  });
});

test('selectors and server validation isolate embedding, rerank and speech models', () => {
  const providers = [{ id: 'p', name: 'Provider', enabled: true }];
  const models = (
    ['language', 'embedding', 'rerank', 'speech', 'image'] as const
  ).map((modelType) => ({
    ...modelInputSchema.parse({
      id: modelType,
      name: modelType,
      modelType,
      modalitiesOutput: modelType === 'image' ? ['image'] : ['text'],
    }),
    providerId: 'p',
  }));
  assert.deepEqual(
    modelOptions(providers, models).map((item) => item.id),
    ['language'],
  );
  for (const type of ['embedding', 'rerank', 'speech', 'image'] as const) {
    assert.deepEqual(
      modelOptions(providers, models, type).map((item) => item.id),
      [type],
    );
    assert.equal(
      modelSupportsType(
        models.find((model) => model.modelType === type)!,
        'language',
      ),
      false,
    );
  }
});
