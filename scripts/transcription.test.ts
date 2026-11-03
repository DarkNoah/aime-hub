import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { experimental_transcribe as transcribe } from 'ai';
import { OpenAICompatibleProvider } from '../apps/server/src/mastra/providers/openai-compatible.js';
import { NewApiProvider } from '../apps/server/src/mastra/providers/newapi.js';
import { XinferenceProvider } from '../apps/server/src/mastra/providers/xinference.js';
import { AudioService } from '../apps/server/src/modules/audio/service.js';
import type { ProviderConfig } from '../apps/server/src/mastra/providers/base-provider.js';
import type {
  requestWebResource,
  WebResource,
} from '../apps/server/src/mastra/web/request.js';
import {
  defaultModelTypes,
  emptyModelDefaults,
  modelDefaultsSchema,
  normalizeModelDefaults,
} from '@aime/shared/providers';

type Request = typeof requestWebResource;
const config = {
  id: 'test',
  type: 'openai',
  baseUrl: 'https://asr.example.test/custom/v1/',
  apiKey: 'synthetic-key',
};
const wav = Buffer.from('RIFF0000WAVEsynthetic-test-audio');
const response = {
  text: '你好，这是语音识别测试。',
  usage: { type: 'duration', seconds: 5 },
};
function fixture(
  raw: unknown = response,
  overrides: Partial<WebResource> = {},
) {
  const calls: Parameters<Request>[] = [];
  const request: Request = async (...args) => {
    calls.push(args);
    return {
      url: args[0],
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(raw)),
      ...overrides,
    };
  };
  return { calls, request };
}

for (const type of ['openai', 'newapi', 'xinference']) {
  const provider = (
    request: Request,
    overrides: Partial<ProviderConfig> = {},
  ) =>
    type === 'openai'
      ? new OpenAICompatibleProvider(
          { ...config, ...overrides },
          undefined,
          request,
        )
      : type === 'xinference'
        ? new XinferenceProvider({ ...config, ...overrides }, request)
        : new NewApiProvider({ ...config, ...overrides }, request);

  test(`${type} transcribes multipart audio through AI SDK and accepts tudao JSON`, async () => {
    const { calls, request } = fixture();
    const result = await transcribe({
      model: provider(request).transcriptionModel('qwen3-asr-0.6b'),
      audio: wav,
      providerOptions: {
        [type]: { language: 'zh', prompt: '测试', temperature: 0 },
      },
      headers: {
        Authorization: 'must-not-override',
        'Content-Type': 'text/plain',
        'x-custom': 'forwarded',
      },
      maxRetries: 0,
    });
    assert.equal(result.text, response.text);
    assert.deepEqual(result.segments, []);
    assert.equal(result.language, undefined);
    assert.equal(
      result.durationInSeconds,
      undefined,
      'billable seconds are not exact audio duration',
    );
    const [url, options] = calls[0];
    assert.equal(url, `${config.baseUrl}audio/transcriptions`);
    assert.equal(options.method, 'POST');
    assert.equal(options.maxBytes, Infinity);
    assert.equal(options.headers?.authorization, `Bearer ${config.apiKey}`);
    assert.equal(options.headers?.['x-custom'], 'forwarded');
    assert.match(
      options.headers!['content-type'],
      /^multipart\/form-data; boundary=/,
    );
    assert.ok(Buffer.isBuffer(options.body));
    const form = await new Response(new Uint8Array(options.body), {
      headers: options.headers,
    }).formData();
    assert.equal(form.get('model'), 'qwen3-asr-0.6b');
    assert.equal(form.get('response_format'), 'json');
    assert.equal(form.get('language'), 'zh');
    assert.equal(form.get('prompt'), '测试');
    assert.equal(form.get('temperature'), '0');
    const file = form.get('file') as File;
    assert.equal(file.name, 'audio.wav');
    assert.equal(file.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
  });

  test(`${type} supports base64 input and preserves actual timing metadata`, async () => {
    const { request } = fixture({
      text: 'Hello.',
      language: 'EN',
      duration: 1.25,
      segments: [{ text: 'Hello.', start: 0.1, end: 1.2 }],
    });
    const result = await transcribe({
      model: provider(request).transcriptionModel('asr'),
      audio: wav.toString('base64'),
      maxRetries: 0,
    });
    assert.equal(result.language, 'en');
    assert.equal(result.durationInSeconds, 1.25);
    assert.deepEqual(result.segments, [
      { text: 'Hello.', startSecond: 0.1, endSecond: 1.2 },
    ]);
  });

  test(`${type} returns plain text through the audio service without trimming or JSON wrappers`, async () => {
    for (const text of [' 你好。😊\n第二行。\n', '']) {
      const { request, calls } =
        type === 'xinference'
          ? fixture({ text })
          : fixture(null, {
              headers: { 'content-type': 'text/plain' },
              body: Buffer.from(text),
            });
      const asr = provider(request);
      const audio = new AudioService('/unused', {
        getTranscriptionModel: async () => asr.transcriptionModel('asr'),
        getSpeechModel: async () => asr.speechModel('speech'),
      });
      assert.equal(
        await audio.transcriptions(wav, {
          response_format: 'text',
          language: 'zh',
        }),
        text,
      );
      assert.equal(calls.length, 1);
      const [, options] = calls[0];
      const form = await new Response(new Uint8Array(options.body as Buffer), {
        headers: options.headers,
      }).formData();
      assert.equal(
        form.get('response_format'),
        type === 'xinference' ? 'json' : 'text',
      );
      assert.equal(form.get('language'), 'zh');
    }
  });

  test(`${type} fails safely on HTTP, invalid JSON and missing transcription text`, async () => {
    for (const overrides of [
      { status: 400, body: Buffer.from('upstream-secret') },
      { body: Buffer.from('upstream-secret') },
      { body: Buffer.from('{"error":"upstream-secret"}') },
    ]) {
      await assert.rejects(
        transcribe({
          model: provider(fixture(null, overrides).request).transcriptionModel(
            'asr',
          ),
          audio: wav,
          maxRetries: 0,
        }),
        (error: Error) => {
          assert.match(error.message, /[Tt]ranscription/);
          assert.doesNotMatch(error.message, /upstream-secret/);
          return true;
        },
      );
    }
    await assert.rejects(
      transcribe({
        model: provider(fixture({ text: '' }).request).transcriptionModel(
          'asr',
        ),
        audio: wav,
        maxRetries: 0,
      }),
      { name: 'AI_NoTranscriptGeneratedError' },
    );
  });

  test(`${type} propagates cancellation and limits request time`, async () => {
    const { request, calls } = fixture();
    await assert.rejects(
      transcribe({
        model: provider(request).transcriptionModel('asr'),
        audio: wav,
        abortSignal: AbortSignal.abort(new Error('cancelled')),
        maxRetries: 0,
      }),
      /cancelled/,
    );
    assert.equal(calls.length, 0);
    const controller = new AbortController();
    await assert.rejects(
      transcribe({
        model: provider(async (...args) => {
          controller.abort(new Error('cancelled-during'));
          return request(...args);
        }).transcriptionModel('asr'),
        audio: wav,
        abortSignal: controller.signal,
        maxRetries: 0,
      }),
      /cancelled-during/,
    );
    await assert.rejects(
      transcribe({
        model: provider(
          async (...args) => {
            await delay(1000, undefined, { signal: args[1].signal });
            return request(...args);
          },
          { timeoutMs: 20 },
        ).transcriptionModel('asr'),
        audio: wav,
        maxRetries: 0,
      }),
      { name: 'AbortError' },
    );
  });
}

test('Xinference ASR normalizes /v1 and discovers only transcription models', async () => {
  const base = 'https://asr.example.test/gateway';
  for (const baseUrl of [base, `${base}/`, `${base}/v1`, `${base}/v1/`]) {
    const { calls, request } = fixture();
    const provider = new XinferenceProvider(
      { ...config, apiKey: null, baseUrl },
      request,
    );
    await transcribe({
      model: provider.transcriptionModel('SenseVoiceSmall'),
      audio: wav,
      maxRetries: 0,
    });
    assert.equal(calls[0][0], `${base}/v1/audio/transcriptions`);
    assert.equal(calls[0][1].headers?.authorization, undefined);
    assert.throws(() => provider.transcriptionModel(' '), /model ID/);
  }
  const { request } = fixture({
    data: [
      {
        id: 'SenseVoiceSmall',
        model_type: 'audio',
        model_ability: ['audio2text'],
      },
      { id: 'whisper', model_type: 'ASR' },
      { id: 'VoxCPM2', model_type: 'audio', model_ability: ['text2audio'] },
      { id: 'chat', model_type: 'LLM' },
    ],
  });
  assert.deepEqual(
    (
      await new XinferenceProvider(config, request).getTranscriptionModelList()
    ).map(({ id }) => id),
    ['SenseVoiceSmall', 'whisper'],
  );
});

test('Xinference preserves native SenseVoice JSON through the audio service', async () => {
  const responses = {
    json: { text: '你好。😊' },
    verbose_json: {
      task: 'transcribe',
      text: '你好。😊',
      duration: 0,
      words: [],
      segments: [],
    },
  } as const;
  for (const response_format of ['json', 'verbose_json'] as const) {
    const expected = responses[response_format];
    const { request, calls } = fixture(expected);
    const provider = new XinferenceProvider(config, request);
    const audio = new AudioService('/unused', {
      getTranscriptionModel: async () =>
        provider.transcriptionModel('SenseVoiceSmall'),
      getSpeechModel: async () => provider.speechModel('VoxCPM2'),
    });
    assert.deepEqual(
      await audio.transcriptions(wav, { language: 'zh', response_format }),
      expected,
    );
    const [, options] = calls[0];
    const form = await new Response(new Uint8Array(options.body as Buffer), {
      headers: options.headers,
    }).formData();
    assert.equal(form.get('model'), 'SenseVoiceSmall');
    assert.equal(form.get('response_format'), response_format);
    assert.equal(form.get('language'), 'zh');
  }
});

test('Xinference rejects unsupported subtitles without silently retrying as JSON', async () => {
  for (const response_format of ['srt', 'vtt'] as const) {
    const { request, calls } = fixture(
      { detail: `Unsupported response format: ${response_format}` },
      { status: 500 },
    );
    await assert.rejects(
      async () =>
        new XinferenceProvider(config, request)
          .transcriptionModel('SenseVoiceSmall')
          .doGenerate({
            audio: wav,
            mediaType: 'audio/wav',
            providerOptions: { xinference: { response_format } },
          }),
      /Transcription request failed \(500\)/,
    );
    assert.equal(calls.length, 1);
    const [, options] = calls[0];
    const form = await new Response(new Uint8Array(options.body as Buffer), {
      headers: options.headers,
    }).formData();
    assert.equal(form.get('response_format'), response_format);
  }
});

test('Xinference text compatibility preserves options and cancellation and rejects invalid JSON', async () => {
  const { request, calls } = fixture({ text: '你好。' });
  const model = new XinferenceProvider(config, request).transcriptionModel(
    'SenseVoiceSmall',
  );
  const extra = Object.freeze({
    response_format: 'text',
    language: 'zh',
    prompt: '测试',
    temperature: 0,
  });
  const options = {
    audio: wav,
    mediaType: 'audio/wav',
    providerOptions: { xinference: extra },
    headers: { 'x-custom': 'forwarded' },
  };
  const result = await model.doGenerate(options);
  assert.equal(result.text, '你好。');
  assert.equal(result.response?.body, '你好。');
  assert.equal(extra.response_format, 'text');
  assert.equal(calls[0][1].headers?.['x-custom'], 'forwarded');
  const form = await new Response(new Uint8Array(calls[0][1].body as Buffer), {
    headers: calls[0][1].headers,
  }).formData();
  assert.equal(form.get('prompt'), '测试');
  assert.equal(form.get('temperature'), '0');
  await assert.rejects(
    async () =>
      model.doGenerate({
        ...options,
        abortSignal: AbortSignal.abort(new Error('text-cancelled')),
      }),
    /text-cancelled/,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    async () =>
      new XinferenceProvider(
        config,
        fixture({ error: 'upstream-secret' }).request,
      )
        .transcriptionModel('SenseVoiceSmall')
        .doGenerate(options),
    /Invalid transcription response/,
  );
});

test('verbose JSON still rejects plain JSON and incomplete verbose metadata', async () => {
  for (const raw of [
    { text: '你好' },
    { text: '你好', task: 'transcribe' },
    { text: '你好', duration: 0 },
    { text: '你好', duration: 0, task: 'unexpected' },
  ]) {
    const { request } = fixture(raw);
    await assert.rejects(
      async () =>
        new XinferenceProvider(config, request)
          .transcriptionModel('SenseVoiceSmall')
          .doGenerate({
            audio: wav,
            mediaType: 'audio/wav',
            providerOptions: {
              xinference: { response_format: 'verbose_json' },
            },
          }),
      /Invalid transcription response/,
    );
  }
});

test('compatible transcription preserves custom base paths and supports no API key', async () => {
  const { request, calls } = fixture();
  const provider = new OpenAICompatibleProvider(
    { ...config, apiKey: null, baseUrl: 'https://asr.example.test/gateway/' },
    undefined,
    request,
  );
  await transcribe({
    model: provider.transcriptionModel('asr'),
    audio: wav,
    maxRetries: 0,
  });
  assert.equal(
    calls[0][0],
    'https://asr.example.test/gateway/audio/transcriptions',
  );
  assert.equal(calls[0][1].headers?.authorization, undefined);
});

test('ASR defaults normalize old settings without changing other selections', () => {
  const { asrModel: _asrModel, ...old } = {
    ...emptyModelDefaults,
    defaultModel: 'provider/chat',
    speechModel: 'provider/speech',
  };
  assert.equal(_asrModel, null);
  assert.deepEqual(normalizeModelDefaults(old), { ...old, asrModel: null });
  assert.equal(
    modelDefaultsSchema.parse({ ...old, asrModel: 'tudao/qwen3-asr-0.6b' })
      .asrModel,
    'tudao/qwen3-asr-0.6b',
  );
  assert.equal(defaultModelTypes.asrModel, 'asr');
});
