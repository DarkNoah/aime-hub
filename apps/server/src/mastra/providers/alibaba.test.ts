import assert from 'node:assert/strict';
import test from 'node:test';
import {
  experimental_generateSpeech as generateSpeech,
  experimental_transcribe as transcribe,
} from 'ai';
import {
  modelInputSchema,
  modelDefaultsSchema,
  emptyModelDefaults,
  providerModelTypes,
} from '@aime/shared/providers';
import { AlibabaProvider } from './alibaba.js';
import { AlibabaSpeechModel } from './alibaba/speech.js';
import { AlibabaTranscriptionModel } from './alibaba/transcription.js';
import { Alibaba3DModel } from './alibaba/model3d.js';
import { uploadToAlibabaOss } from './alibaba/upload.js';
import type { requestWebResource } from '../web/request.js';
import { AudioService } from '../../modules/audio/service.js';

const nativeBase = 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1';
const options = {
  apiKey: 'synthetic-alibaba-key',
  apiBase: nativeBase,
  region: 'cn-beijing',
};
const config = {
  id: 'alibaba-test',
  type: 'alibaba-cn',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: options.apiKey,
  metadata: { workspaceId: 'workspace', region: 'cn-beijing' },
};
const json = (value: unknown, status = 200) => ({
  url: nativeBase,
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(value)),
});
function wav() {
  const data = Buffer.alloc(48);
  data.write('RIFF');
  data.writeUInt32LE(40, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(4, 40);
  return data;
}
const policy = {
  upload_host: 'https://upload.example.test',
  upload_dir: 'temporary',
  oss_access_key_id: 'oss-id',
  signature: 'signature',
  policy: 'policy',
  x_oss_object_acl: 'private',
  x_oss_forbid_overwrite: 'true',
  max_file_size_mb: 20,
};

test('Alibaba discovery uses native model types, region restrictions and compatible chat', async () => {
  const provider = new AlibabaProvider(config);
  assert.equal(provider.languageModel('qwen-plus').api, 'chat');
  const list = await provider.getModelList();
  assert.equal(new Set(list.map(({ id }) => id)).size, list.length);
  for (const model of list) modelInputSchema.parse(model);
  assert.equal(
    list.find(({ id }) => id === 'qwen3-asr-flash')?.modelType,
    'asr',
  );
  assert.equal(
    list.find(({ id }) => id === 'cosyvoice-v3-plus')?.modelType,
    'speech',
  );
  assert.deepEqual(
    list.find(({ id }) => id === 'Tripo/Tripo-H3.1')?.modalitiesOutput,
    ['model3d'],
  );
  const overseas = await new AlibabaProvider({
    ...config,
    metadata: { region: 'ap-southeast-1' },
  }).getModelList();
  assert.ok(overseas.some(({ id }) => id === 'qwen3-tts-flash'));
  assert.ok(
    !overseas.some(
      ({ id }) => id.startsWith('Tripo/') || id.startsWith('cosyvoice-'),
    ),
  );
  assert.ok(providerModelTypes('alibaba').includes('model3d'));
  assert.ok(!providerModelTypes('openai').includes('model3d'));
  assert.ok(!providerModelTypes('xinference').includes('model3d'));
  assert.equal(
    modelDefaultsSchema.parse({
      ...emptyModelDefaults,
      model3dModel: 'provider/Tripo/Tripo-H3.1',
    }).model3dModel,
    'provider/Tripo/Tripo-H3.1',
  );
});

test('Workspace validation happens only for native calls; chat remains available', () => {
  const provider = new AlibabaProvider({ ...config, metadata: {} });
  assert.equal(provider.languageModel('qwen-plus').api, 'chat');
  assert.throws(() => provider.speechModel('qwen3-tts-flash'), /Workspace/);
  for (const metadata of [
    { workspaceId: 'bad/path' },
    { workspaceId: 'valid', region: 'bad.region' },
  ])
    assert.throws(() =>
      new AlibabaProvider({ ...config, metadata }).model3d('Tripo/Tripo-H3.1'),
    );
});

for (const [id, endpoint, field] of [
  [
    'qwen-audio-3.0-tts-plus',
    `${nativeBase}/services/audio/tts/SpeechSynthesizer`,
    'voice',
  ],
  [
    'cosyvoice-v3-plus',
    `${nativeBase}/services/audio/tts/SpeechSynthesizer`,
    'voice',
  ],
  [
    'qwen3-tts-flash',
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    'voice',
  ],
  [
    'MiniMax/speech-2.8-hd',
    `${nativeBase}/services/aigc/multimodal-generation/generation`,
    'voice_setting',
  ],
] as const) {
  test(`speech ${id} maps payloads and returns SDK audio without leaking credentials`, async () => {
    let calls = 0;
    const request: typeof requestWebResource = async (url, init) => {
      calls++;
      assert.equal(init.timeoutMs, 0);
      if (calls === 1) {
        assert.equal(url, endpoint);
        assert.equal(init.headers?.authorization, `Bearer ${options.apiKey}`);
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, id);
        assert.equal(body.input.text, '你好');
        assert.ok(body.input[field]);
        return json({
          output: id.startsWith('MiniMax/')
            ? {
                data: { audio: wav().toString('hex') },
                base_resp: { status_code: 0 },
              }
            : { audio: { url: 'https://media.example.test/speech.wav' } },
        });
      }
      assert.equal(url, 'https://media.example.test/speech.wav');
      assert.equal(init.headers?.authorization, undefined);
      return { ...json(null), body: wav() };
    };
    const result = await generateSpeech({
      model: new AlibabaSpeechModel({ ...options, modelId: id, request }),
      text: '你好',
      outputFormat: 'wav',
      maxRetries: 0,
    });
    assert.deepEqual(Buffer.from(result.audio.uint8Array), wav());
    assert.equal(calls, id.startsWith('MiniMax/') ? 1 : 2);
  });
}

test('speech rejects unsupported voice, region and format combinations before requests', async () => {
  let calls = 0;
  const request: typeof requestWebResource = async () => {
    calls++;
    return json({});
  };
  const model = (modelId: string) =>
    new AlibabaSpeechModel({ ...options, modelId, request });
  await assert.rejects(
    model('cosyvoice-v3.5-plus').doGenerate({ text: 'hello' }),
    /custom voice/,
  );
  await assert.rejects(
    model('qwen3-tts-flash').doGenerate({ text: 'hello', outputFormat: 'mp3' }),
    /output format/,
  );
  await assert.rejects(
    model('qwen3-tts-flash').doGenerate({ text: 'hello', speed: 2 }),
    /speed/,
  );
  await assert.rejects(
    model('cosyvoice-v3-plus').doGenerate({
      text: 'hello',
      providerOptions: {
        alibaba: { reference_audio: 'data:audio/wav;base64,AA==' },
      },
    }),
    /voice ID/,
  );
  assert.throws(
    () =>
      new AlibabaSpeechModel({
        ...options,
        region: 'us-east-1',
        modelId: 'qwen3-tts-flash',
      }),
    /not supported/,
  );
  assert.equal(calls, 0);
});

test('Flash ASR works through AI SDK and AudioService JSON/text/subtitle paths', async () => {
  const request: typeof requestWebResource = async (url, init) => {
    assert.equal(
      url,
      `${nativeBase}/services/aigc/multimodal-generation/generation`,
    );
    const body = JSON.parse(String(init.body));
    assert.equal(body.parameters.format, 'wav');
    assert.ok(
      body.input.messages[0].content[0].input_audio.data.startsWith(
        'data:audio/wav;base64,',
      ),
    );
    return json({
      output: {
        sentence: {
          text: '你好。',
          begin_time: 100,
          end_time: 1500,
          language: 'zh',
          words: [
            {
              text: '你好',
              punctuation: '。',
              begin_time: 100,
              end_time: 1500,
            },
          ],
        },
      },
      usage: { duration: 2 },
    });
  };
  const model = new AlibabaTranscriptionModel({
    ...options,
    modelId: 'qwen-audio-3.0-asr-flash',
    request,
  });
  const sdk = await transcribe({ model, audio: wav(), maxRetries: 0 });
  assert.equal(sdk.text, '你好。');
  assert.equal(sdk.segments[0].startSecond, 0.1);
  const audio = new AudioService('/tmp/alibaba-unit-tests', {
    getTranscriptionModel: async () => model,
    getSpeechModel: async () => {
      throw new Error('unused');
    },
  });
  assert.equal(
    ((await audio.transcriptions(wav())) as { text: string }).text,
    '你好。',
  );
  assert.equal(
    await audio.transcriptions(wav(), { response_format: 'text' }),
    '你好。',
  );
  assert.match(
    String(await audio.transcriptions(wav(), { response_format: 'srt' })),
    /00:00:00,100 --> 00:00:01,500/,
  );
  assert.match(
    String(await audio.transcriptions(wav(), { response_format: 'vtt' })),
    /^WEBVTT\n/,
  );
  assert.equal(
    (
      (await audio.transcriptions(wav(), {
        response_format: 'verbose_json',
      })) as { language: string }
    ).language,
    'zh',
  );
});

test('Qwen text-only ASR maps messages and rejects invented subtitles', async () => {
  let calls = 0;
  const model = new AlibabaTranscriptionModel({
    ...options,
    modelId: 'qwen3-asr-flash',
    request: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init.body));
      assert.ok(body.input.messages[0].content[0].audio);
      return json({
        output: { choices: [{ message: { content: [{ text: 'hello' }] } }] },
      });
    },
  });
  const result = await model.doGenerate({
    audio: wav(),
    mediaType: 'audio/wav',
  });
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.segments, []);
  await assert.rejects(
    model.doGenerate({
      audio: wav(),
      mediaType: 'audio/wav',
      providerOptions: { alibaba: { response_format: 'srt' } },
    }),
    /timestamps/,
  );
  assert.equal(calls, 1);
});

for (const modelId of ['fun-asr', 'qwen3-asr-flash-filetrans']) {
  test(`async ${modelId} uploads local audio and normalizes signed transcript results`, async () => {
    const calls: string[] = [];
    const request: typeof requestWebResource = async (url, init) => {
      calls.push(url);
      if (url.includes('/uploads?')) return json({ data: policy });
      if (url === policy.upload_host + '/') {
        assert.equal(init.headers?.authorization, undefined);
        const form = await new Response(new Uint8Array(init.body as Buffer), {
          headers: init.headers,
        }).formData();
        assert.equal(form.get('OSSAccessKeyId'), policy.oss_access_key_id);
        assert.equal(Array.from(form.keys()).at(-1), 'file');
        return json({});
      }
      if (url.endsWith('/asr/transcription')) {
        const body = JSON.parse(String(init.body));
        assert.equal(
          init.headers?.['X-DashScope-OssResourceResolve'],
          'enable',
        );
        assert.equal(init.headers?.['X-DashScope-Async'], 'enable');
        const source = modelId.startsWith('qwen3')
          ? body.input.file_url
          : body.input.file_urls[0];
        assert.ok(source.startsWith('oss://temporary/'));
        const entry = {
          transcription_url: 'https://result.example.test/transcript.json',
          subtask_status: 'SUCCEEDED',
        };
        return json({
          output: {
            task_id: 'task',
            task_status: 'SUCCEEDED',
            ...(modelId.startsWith('qwen3')
              ? { result: entry }
              : { results: [entry] }),
          },
        });
      }
      assert.equal(url, 'https://result.example.test/transcript.json');
      assert.equal(init.headers?.authorization, undefined);
      return json({
        properties: { original_duration_in_milliseconds: 5000 },
        transcripts: [
          {
            text: 'Hello',
            sentences: [
              {
                text: 'Hello',
                begin_time: 1000,
                end_time: 2000,
                language: 'en',
              },
            ],
          },
        ],
      });
    };
    const result = await new AlibabaTranscriptionModel({
      ...options,
      modelId,
      request,
    }).doGenerate({ audio: wav(), mediaType: 'audio/wav' });
    assert.equal(result.text, 'Hello');
    assert.equal(result.durationInSeconds, 5);
    assert.deepEqual(result.segments, [
      { text: 'Hello', startSecond: 1, endSecond: 2 },
    ]);
    assert.equal(calls.length, 4);
  });
}

test('ASR cancellation interrupts polling immediately and prevents subsequent requests', async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = new AlibabaTranscriptionModel({
    ...options,
    modelId: 'fun-asr',
    request: async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return json({ output: { task_id: 'pending', task_status: 'PENDING' } });
    },
  });
  await assert.rejects(
    model.doGenerateFromUrl({
      url: 'https://audio.example.test/audio.wav',
      abortSignal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('3D text/single/multi-view payloads, task results and PBR preference', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const model = new Alibaba3DModel({
    ...options,
    modelId: 'Tripo/Tripo-H3.1',
    request: async (url, init) => {
      if (init.method === 'POST') {
        assert.equal(
          url,
          `${nativeBase}/services/aigc/video-generation/3d-generation`,
        );
        assert.equal(init.headers?.['X-DashScope-Async'], 'enable');
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.input.image)
          assert.equal(
            init.headers?.['X-DashScope-OssResourceResolve'],
            'enable',
          );
        return json({ output: { task_id: 'task/1', task_status: 'PENDING' } });
      }
      assert.equal(url, `${nativeBase}/tasks/task%2F1`);
      return json({
        output: {
          task_id: 'task/1',
          task_status: 'SUCCEEDED',
          results: [
            {
              pbr_model_url: 'https://cdn.example.test/pbr.glb',
              base_model_url: 'https://cdn.example.test/base.glb',
              rendered_image_url: 'https://cdn.example.test/preview.png',
            },
          ],
        },
      });
    },
  });
  assert.equal(
    (await model.doGenerate({ prompt: 'cat', geometryQuality: 'ultra' }))
      .status,
    'queued',
  );
  await model.doGenerate({ image: 'oss://temporary/cat.png' });
  await model.doGenerate({
    images: [
      { view: 'right', image: 'https://images.example.test/right.png' },
      { view: 'front', image: 'https://images.example.test/front.jpg' },
    ],
  });
  assert.deepEqual(bodies[2].input, {
    images: [
      { type: 'jpeg', file_token: 'https://images.example.test/front.jpg' },
      {},
      {},
      { type: 'png', file_token: 'https://images.example.test/right.png' },
    ],
  });
  assert.equal(
    (await model.getTask('task/1')).results?.[0].url,
    'https://cdn.example.test/pbr.glb',
  );
  await assert.rejects(
    model.doGenerate({
      prompt: 'cat',
      image: 'https://images.example.test/cat.png',
    }),
    /exactly one/,
  );
  await assert.rejects(
    model.doGenerate({
      images: [
        { view: 'front', image: 'https://images.example.test/a.png' },
        { view: 'front', image: 'https://images.example.test/b.png' },
      ],
    }),
    /distinct/,
  );
  assert.throws(
    () =>
      new Alibaba3DModel({
        ...options,
        region: 'ap-southeast-1',
        modelId: 'Tripo/Tripo-H3.1',
      }),
    /not supported/,
  );
  const lowpoly = new Alibaba3DModel({
    ...options,
    modelId: 'Tripo/Tripo-P1.0',
  });
  await assert.rejects(
    lowpoly.doGenerate({ prompt: 'cat', geometryQuality: 'ultra' }),
    /only by Tripo/,
  );
});

test('upstream failures, malformed output and pre-abort are rejected without exposing secrets', async () => {
  for (const response of [
    json({ message: options.apiKey }, 500),
    json({ code: 'InvalidApiKey', message: options.apiKey }),
    json({ output: { data: { audio: 'xyz' } } }),
  ]) {
    const model = new AlibabaSpeechModel({
      ...options,
      modelId: 'MiniMax/speech-2.8-hd',
      request: async () => response,
    });
    await assert.rejects(
      model.doGenerate({ text: 'hello' }),
      (error: Error) => !error.message.includes(options.apiKey),
    );
  }
  let calls = 0;
  const model = new Alibaba3DModel({
    ...options,
    modelId: 'Tripo/Tripo-H3.1',
    request: async () => {
      calls++;
      return json({});
    },
  });
  await assert.rejects(
    model.doGenerate({ prompt: 'cat', abortSignal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    uploadToAlibabaOss(
      { ...policy, upload_host: 'http://upload.example.test' },
      { data: wav(), fileName: 'audio.wav', mimeType: 'audio/wav' },
    ),
    /upload host/,
  );
});
