import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegPath } from '../audio/binaries.js';
import type { SpeechModel } from 'ai';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { RequestContext } from '@mastra/core/request-context';
import { Memory } from '@mastra/memory';
import { defaultSpeechConfig, speechConfigSchema } from '@aime/shared/tools';
import { emptyModelDefaults } from '@aime/shared/providers';
import { speechFormats, speechMediaTypes } from '@aime/shared/audio';
import { XinferenceProvider } from '../../mastra/providers/xinference.js';
import { createSpeechModel } from '../../mastra/providers/openai-compatible-speech.js';
import { wavMetadata } from '../../mastra/providers/audio-data.js';
import { createSpeechTool } from '../../mastra/tools/speech.js';
import { AudioService } from '../audio/service.js';
import { SpeechPlayback } from '../audio/playback.js';
import type { SpeechEvent } from '@aime/shared/audio';
import { ToolService } from './service.js';
import { parseSpeechOutput } from '../../../../web/src/components/chat/message-preview/speech-output.js';
import { getToolAttachments } from '../../../../web/src/components/chat/tool-attachments.js';

const wav = Buffer.alloc(16044);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(16000, 40);
const providerConfig = {
  id: 'voices',
  baseUrl: 'https://speech.example',
  apiKey: 'synthetic-secret',
};
type Request = NonNullable<ConstructorParameters<typeof XinferenceProvider>[1]>;
function fixture(request?: Request) {
  const calls: Parameters<Request>[] = [];
  const transport: Request = async (url, options) => {
    calls.push([url, options]);
    return request
      ? request(url, options)
      : {
          url,
          status: 200,
          headers: { 'content-type': 'audio/wav' },
          body: wav,
        };
  };
  const provider = new XinferenceProvider(providerConfig, transport);
  const resolveModel = async () => ({
    reference: 'voices/VoxCPM2',
    model: provider.speechModel('VoxCPM2'),
  });
  return { calls, provider, resolveModel };
}
function runnable(tool: ReturnType<typeof createSpeechTool>) {
  type Execute = NonNullable<typeof tool.execute>;
  return async (
    input: Parameters<Execute>[0],
    context: Partial<Parameters<Execute>[1]> = {},
  ) => {
    const result = await tool.execute!(input, {
      observe: { span: async (_name, fn) => fn(), log: () => {} },
      ...context,
    });
    assert.ok(result && typeof result === 'object' && 'file_path' in result);
    return result;
  };
}
async function workspace(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'speech-tool-'));
  const value = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await value.init();
  t.after(async () => {
    await value.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  return { workspace: value, directory };
}
const scope = {
  agentId: 'agent',
  toolCallId: 'call',
  messages: [],
  suspend: async () => {},
  threadId: 'thread0000000001',
  resourceId: 'user:owner',
};

test(
  'live Xinference speech tool generates a real WAV in the workspace',
  { skip: process.env.XINFERENCE_TEST_TOOL !== '1' },
  async (t) => {
    const config = process.env.XINFERENCE_CONFIG_FILE
      ? (JSON.parse(
          await readFile(process.env.XINFERENCE_CONFIG_FILE, 'utf8'),
        ) as { baseUrl: string; apiKey?: string })
      : {
          baseUrl: process.env.XINFERENCE_BASE_URL,
          apiKey: process.env.XINFERENCE_API_KEY,
        };
    assert.ok(
      config.baseUrl,
      'Set XINFERENCE_BASE_URL or XINFERENCE_CONFIG_FILE',
    );
    const provider = new XinferenceProvider({
      ...config,
      baseUrl: config.baseUrl,
      id: 'live-speech',
      timeoutMs: 300000,
    });
    const models = await provider.getModelList();
    const selected = models.find(
      (model) =>
        model.modelType === 'speech' &&
        (!process.env.XINFERENCE_SPEECH_MODEL ||
          model.id === process.env.XINFERENCE_SPEECH_MODEL),
    );
    assert.ok(selected, 'No speech model available');
    const w = await workspace(t);
    const reference = process.env.XINFERENCE_REFERENCE_AUDIO;
    const audio = new AudioService(await realpath(w.directory), {
      getSpeechModel: async () => {
        throw new Error('Unused');
      },
      getTranscriptionModel: async () => {
        throw new Error('Unused');
      },
    });
    const savedVoice = reference
      ? await audio.voices.create(
          'owner',
          {
            name: 'Live test voice',
            text: process.env.XINFERENCE_PROMPT_TEXT ?? '',
          },
          await readFile(reference),
        )
      : undefined;
    assert.ok(
      savedVoice || process.env.XINFERENCE_SPEECH_VOICE,
      'Set XINFERENCE_REFERENCE_AUDIO or XINFERENCE_SPEECH_VOICE',
    );
    const recorded: unknown[] = [];
    const tool = createSpeechTool(defaultSpeechConfig, {
      audio,
      resolveModel: async () => ({
        reference: `live-speech/${selected.id}`,
        model: provider.speechModel(selected.id, { modelName: selected.name }),
      }),
      recordAsset: async (asset) => {
        recorded.push(asset);
      },
    });
    const started = Date.now();
    const output = await runnable(tool)(
      {
        input:
          process.env.XINFERENCE_SPEECH_TEXT ??
          '你好，这是语音工具的真实测试。',
        instructions: process.env.XINFERENCE_SPEECH_INSTRUCT,
        voice: savedVoice?.id ?? process.env.XINFERENCE_SPEECH_VOICE,
      },
      { ...w, agent: scope },
    );
    assert.equal(recorded.length, 1);
    const data = await readFile(join(w.directory, output.file_path!));
    const outputPath =
      process.env.XINFERENCE_SPEECH_OUTPUT ?? '/tmp/xinference-speech-tool.wav';
    await writeFile(outputPath, data);
    console.log(
      JSON.stringify({
        speechTool: {
          model: selected.id,
          output: outputPath,
          bytes: data.length,
          ...wavMetadata(data),
          elapsedMs: Date.now() - started,
          reference: !!reference,
          assets: recorded.length,
        },
      }),
    );
  },
);

test('speech returns only duration, file_path and sample_rate while preserving playback and asset registration', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  const recorded: unknown[] = [];
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: f.resolveModel,
    recordAsset: async (asset) => {
      recorded.push(asset);
    },
  });
  const output = await runnable(tool)(
    {
      input: 'Hello',
      voice: 'alloy',
      instructions: 'Happy and bright',
      save_path: 'outputs/audio/hello world.wav',
    },
    { ...w, agent: scope },
  );
  assert.deepEqual(Object.keys(output).sort(), [
    'duration',
    'file_path',
    'sample_rate',
  ]);
  assert.deepEqual(await readFile(join(w.directory, output.file_path!)), wav);
  assert.equal(output.duration, 1);
  assert.equal(output.sample_rate, 8000);
  const payload = JSON.parse(String(f.calls[0][1].body));
  assert.equal(payload.response_format, 'wav');
  assert.deepEqual(JSON.parse(payload.kwargs), {
    control_instruction: 'Happy and bright',
  });
  assert.equal(f.calls[0][0], 'https://speech.example/v1/audio/speech');
  assert.equal(f.calls[0][1].headers?.authorization, 'Bearer synthetic-secret');
  const blocks = parseSpeechOutput(output, scope.threadId)!.audio;
  assert.deepEqual(
    blocks.find((block) => block.type === 'media'),
    {
      type: 'media',
      mediaType: 'audio/wav',
      filename: output.file_path,
      source:
        '/api/threads/thread0000000001/files/raw?path=outputs%2Faudio%2Fhello+world.wav',
    },
  );
  const attachments = getToolAttachments(
    [
      {
        type: 'dynamic-tool',
        toolName: 'speech',
        toolCallId: 'call',
        state: 'output-available',
        input: { input: 'Hello', voice: 'alloy' },
        output,
      },
    ],
    scope.threadId,
  );
  assert.equal(attachments[0]?.mediaType, 'audio/wav');
  const modelOutput = tool.toModelOutput!(output);
  assert.ok(
    modelOutput && typeof modelOutput === 'object' && 'type' in modelOutput,
  );
  assert.equal(modelOutput.type, 'text');
  assert.deepEqual(modelOutput, {
    type: 'text',
    value: JSON.stringify(output),
  });
  assert.doesNotMatch(
    JSON.stringify(tool.toModelOutput!(output)),
    /synthetic-secret|base64|\/api\/threads/,
  );
  assert.deepEqual(recorded, [
    {
      threadId: scope.threadId,
      resourceId: scope.resourceId,
      createdBy: 'owner',
      mimeType: 'audio/wav',
      size: wav.length,
      path: output.file_path,
      toolName: 'speech',
      toolCallId: 'call',
      model: 'voices/VoxCPM2',
      metadata: { duration: 1, sampleRate: 8000 },
    },
  ]);
  await assert.rejects(
    runnable(tool)(
      { input: 'Hello', voice: 'alloy', save_path: output.file_path },
      { ...w, agent: scope },
    ),
  );
  assert.equal(recorded.length, 1);
});

test('speech schema accepts voice or a reference pair and rejects missing, mixed or incomplete sources', async () => {
  const tool = createSpeechTool();
  const validate = (input: unknown) =>
    tool.inputSchema!['~standard'].validate(input);
  const valid = await validate({
    input: 'Hello',
    voice: 'alloy',
    instructions: 'Cheerfully',
    response_format: 'wav',
    speed: 1.2,
    save_path: 'hello.wav',
  });
  assert.equal(valid.issues, undefined);
  for (const source of [
    { reference_audio: '.uploads/reference.wav', reference_text: '原录音内容' },
    {
      voice: ' ',
      reference_audio: 'reference.wav',
      reference_text: '原录音内容',
    },
    { voice: 'alloy', reference_audio: '', reference_text: ' ' },
  ])
    assert.equal(
      (await validate({ input: 'Hello', ...source })).issues,
      undefined,
    );
  for (const source of [
    {},
    { voice: ' ' },
    { reference_audio: 'reference.wav' },
    { reference_text: '原录音内容' },
    { reference_audio: 'reference.wav', reference_text: ' ' },
    { reference_audio: '', reference_text: '原录音内容' },
    { voice: 'alloy', reference_audio: 'reference.wav' },
    { voice: 'alloy', reference_text: '原录音内容' },
    {
      voice: 'alloy',
      reference_audio: 'reference.wav',
      reference_text: '原录音内容',
    },
  ])
    assert.ok(
      (await validate({ input: 'Hello', ...source })).issues,
      JSON.stringify(source),
    );
  for (const legacy of [
    { text: 'Hello' },
    { voice_id: 'alloy' },
    { instruct: 'Cheerfully' },
    { language: 'en' },
    { model: 'untrusted-model' },
    { ref_audio: 'reference.wav' },
    { ref_text: 'Reference transcript' },
  ]) {
    assert.ok(
      (await validate({ input: 'Hello', voice: 'alloy', ...legacy })).issues,
    );
  }
});

test('direct reference cloning sends workspace audio and its transcript to Xinference without a voice library', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  await w.workspace.filesystem!.writeFile('.uploads/reference.wav', wav, {
    recursive: true,
  });
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: f.resolveModel,
  });
  for (const reference_audio of [
    '.uploads/reference.wav',
    '/.uploads/reference.wav',
    join(w.directory, '.uploads/reference.wav'),
  ]) {
    const result = await runnable(tool)(
      {
        input: '新的台词',
        reference_audio,
        reference_text: '  这是参考录音中的原文。  ',
        instructions: 'Speak gently',
      },
      w,
    );
    assert.deepEqual(await readFile(join(w.directory, result.file_path)), wav);
    const options = f.calls.at(-1)![1];
    const form = await new Response(options.body as BodyInit, {
      headers: options.headers,
    }).formData();
    assert.equal(form.get('voice'), '');
    assert.equal(form.get('input'), '新的台词');
    assert.deepEqual(JSON.parse(String(form.get('kwargs'))), {
      prompt_text: '这是参考录音中的原文。',
      control_instruction: 'Speak gently',
    });
    const file = form.get('prompt_speech') as File;
    assert.equal(file.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
  }
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    await w.workspace.filesystem!.readFile('.uploads/reference.wav'),
    wav,
  );
});

test('invalid voice selections never resolve a model or enqueue playback', async () => {
  const events: SpeechEvent[] = [];
  const playback = new SpeechPlayback((event) => {
    events.push(event);
  });
  const requestContext = new RequestContext();
  requestContext.set('speechPlayback', playback);
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: async () => {
      throw new Error('Invalid inputs must not resolve a model');
    },
  });
  for (const play_immediately of [false, true]) {
    for (const source of [
      {},
      { reference_audio: 'reference.wav' },
      {
        voice: 'alloy',
        reference_audio: 'reference.wav',
        reference_text: 'Reference transcript',
      },
    ]) {
      const result = await tool.execute!(
        { input: 'Hello', play_immediately, ...source },
        {
          requestContext,
          observe: { span: async (_name, fn) => fn(), log: () => {} },
        },
      );
      assert.ok(
        result &&
          typeof result === 'object' &&
          'error' in result &&
          result.error,
      );
    }
  }
  assert.deepEqual(events, []);
  assert.equal(playback.active, false);
  await playback.close();
});

test('OpenAI-compatible cloning sends reference fields in the body for saved and direct voices, including streaming playback', async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.directory, 'reference.wav'), wav);
  const audio = new AudioService(await realpath(w.directory), {
    getSpeechModel: async () => {
      throw new Error('Unused');
    },
    getTranscriptionModel: async () => {
      throw new Error('Unused');
    },
  });
  const saved = await audio.voices.create(
    'owner',
    { name: 'Reference voice', text: 'Reference transcript' },
    wav,
  );
  for (const streaming of [false, true]) {
    for (const source of [
      { voice: saved.id },
      {
        reference_audio: 'reference.wav',
        reference_text: 'Reference transcript',
      },
    ]) {
      await t.test(
        `${streaming ? 'streaming' : 'file'} / ${'voice' in source ? 'library' : 'direct'}`,
        async () => {
          const requests: Record<string, unknown>[] = [];
          const model = createSpeechModel(
            {
              id: 'compatible',
              type: 'openai',
              baseUrl: 'https://speech.example/v1',
            },
            'tts',
            {
              metadata: {
                speechStreaming: streaming,
                speechDefaultVoice: 'zh-female',
              },
            },
            async (url, options) => {
              requests.push(JSON.parse(String(options.body)));
              return {
                url,
                status: 200,
                headers: { 'content-type': 'audio/wav' },
                body: wav,
              };
            },
            async (url, options, consumer) => {
              requests.push(JSON.parse(String(options.body)));
              consumer.response({
                url,
                status: 200,
                headers: { 'content-type': 'audio/pcm' },
              });
              await consumer.chunk(new Uint8Array([0, 1]));
            },
          );
          const events: SpeechEvent[] = [];
          const playback = new SpeechPlayback((event) => {
            events.push(event);
          });
          const requestContext = new RequestContext();
          requestContext.set('speechPlayback', playback);
          const tool = createSpeechTool(defaultSpeechConfig, {
            resolveModel: async () => ({ reference: 'compatible/tts', model }),
            audio,
          });
          const result = await tool.execute!(
            { input: 'New speech', ...source, play_immediately: streaming },
            {
              ...w,
              agent: scope,
              requestContext,
              observe: { span: async (_name, fn) => fn(), log: () => {} },
            },
          );
          if (streaming) {
            assert.ok(
              result &&
                typeof result === 'object' &&
                'status' in result &&
                result.status === 'queued',
            );
            await playback.settled();
            assert.deepEqual(
              events.map((event) => event.phase),
              ['start', 'chunk', 'end'],
            );
          } else {
            assert.ok(
              result && typeof result === 'object' && 'file_path' in result,
            );
            assert.deepEqual(
              await readFile(join(w.directory, result.file_path)),
              wav,
            );
          }
          await playback.close();
          assert.equal(requests.length, 1);
          assert.equal(requests[0].reference_audio, wav.toString('base64'));
          assert.equal(requests[0].reference_text, 'Reference transcript');
          assert.equal(requests[0].input, 'New speech');
          assert.equal(requests[0].voice, undefined);
          assert.equal(requests[0].response_format, streaming ? 'pcm' : 'wav');
          assert.equal(requests[0].stream, streaming ? true : undefined);
          assert.equal(requests[0].kwargs, undefined);
          assert.equal(requests[0].prompt_speech, undefined);
        },
      );
    }
  }
});

test('reference cloning rejects inaccessible or invalid audio and unsupported providers before synthesis', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  const outside = await workspace(t);
  await writeFile(join(outside.directory, 'outside.wav'), wav);
  await writeFile(join(w.directory, 'invalid.wav'), 'not audio');
  await symlink(
    join(outside.directory, 'outside.wav'),
    join(w.directory, 'escaped.wav'),
  );
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: f.resolveModel,
  });
  for (const reference_audio of [
    'missing.wav',
    '../outside.wav',
    join(outside.directory, 'outside.wav'),
    'escaped.wav',
    'invalid.wav',
  ]) {
    await assert.rejects(
      runnable(tool)(
        {
          input: 'Hello',
          reference_audio,
          reference_text: 'Original transcript',
        },
        w,
      ),
      /Could not read reference_audio/,
    );
  }
  assert.equal(f.calls.length, 0);
  const unsupported = createSpeechTool(defaultSpeechConfig, {
    resolveModel: async () => ({
      reference: 'other/tts',
      model: {
        specificationVersion: 'v3',
        provider: 'openai.speech',
        modelId: 'tts',
        doGenerate: async () => {
          throw new Error('Must not generate');
        },
      },
    }),
  });
  await assert.rejects(
    runnable(unsupported)(
      {
        input: 'Hello',
        reference_audio: 'reference.wav',
        reference_text: 'Original transcript',
      },
      w,
    ),
    /compatible model/,
  );
});

test('reference cloning supports immediate playback without saving an output', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  await writeFile(join(w.directory, 'reference.wav'), wav);
  const events: SpeechEvent[] = [];
  const playback = new SpeechPlayback((event) => {
    events.push(event);
  });
  t.after(() => playback.close());
  const requestContext = new RequestContext();
  requestContext.set('speechPlayback', playback);
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: f.resolveModel,
    recordAsset: async () => {
      assert.fail('Immediate playback must not save assets');
    },
  });
  const result = await tool.execute!(
    {
      input: '新的台词',
      reference_audio: 'reference.wav',
      reference_text: '参考录音',
      play_immediately: true,
    },
    {
      ...w,
      requestContext,
      observe: { span: async (_name, fn) => fn(), log: () => {} },
    },
  );
  assert.ok(
    result &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'queued',
  );
  await playback.settled();
  assert.deepEqual(
    events.map((event) => event.phase),
    ['start', 'chunk', 'end'],
  );
  const options = f.calls[0][1];
  const form = await new Response(options.body as BodyInit, {
    headers: options.headers,
  }).formData();
  assert.equal(JSON.parse(String(form.get('kwargs'))).prompt_text, '参考录音');
  assert.equal(await w.workspace.filesystem!.exists('outputs'), false);
});

test('cancelling while reading reference audio prevents synthesis and returns cancellation text', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  await writeFile(join(w.directory, 'reference.wav'), wav);
  const controller = new AbortController();
  t.mock.method(w.workspace.filesystem!, 'readFile', async () => {
    controller.abort();
    return wav;
  });
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: f.resolveModel,
  });
  const result = await tool.execute!(
    {
      input: 'Hello',
      reference_audio: 'reference.wav',
      reference_text: 'Original transcript',
    },
    {
      ...w,
      abortSignal: controller.signal,
      observe: { span: async (_name, fn) => fn(), log: () => {} },
    },
  );
  assert.equal(result, 'Speech generation was cancelled.');
  assert.equal(f.calls.length, 0);
});

test('OpenAI-style arguments reach the configured speech model without exposing model selection', async (t) => {
  const w = await workspace(t);
  const calls: Parameters<Exclude<SpeechModel, string>['doGenerate']>[0][] = [];
  const references: (string | null)[] = [];
  const model: SpeechModel = {
    specificationVersion: 'v3',
    provider: 'openai.speech',
    modelId: 'configured-tts',
    doGenerate: async (options) => {
      calls.push(options);
      return {
        audio: wav,
        warnings: [],
        response: { timestamp: new Date(), modelId: 'configured-tts' },
      };
    },
  };
  const tool = createSpeechTool(
    { ...defaultSpeechConfig, model: 'provider/configured-tts' },
    {
      resolveModel: async (reference) => {
        references.push(reference);
        return { reference: reference!, model };
      },
    },
  );
  await runnable(tool)(
    {
      input: 'Hello from the configured model',
      voice: 'provider-voice',
      instructions: 'Speak gently',
      response_format: 'wav',
      speed: 1.2,
    },
    w,
  );
  assert.deepEqual(references, ['provider/configured-tts']);
  assert.equal(calls[0].text, 'Hello from the configured model');
  assert.equal(calls[0].voice, 'provider-voice');
  assert.equal(calls[0].instructions, 'Speak gently');
  assert.equal(calls[0].speed, 1.2);
  assert.equal(calls[0].outputFormat, 'wav');
  assert.equal(calls[0].language, undefined);
  assert.equal(calls[0].providerOptions?.xinference?.promptSpeech, undefined);
});

test('speech saves each response format with matching metadata, extension and asset MIME type', async (t) => {
  assert.ok(ffmpegPath);
  const w = await workspace(t);
  const source = join(w.directory, 'source.wav');
  await writeFile(source, wav);
  for (const format of speechFormats) {
    const encoded = join(w.directory, `source.${format}`);
    if (format !== 'wav')
      await promisify(execFile)(ffmpegPath, [
        '-nostdin',
        '-v',
        'error',
        '-i',
        source,
        ...(format === 'pcm'
          ? ['-ar', '24000', '-ac', '1', '-f', 's16le']
          : []),
        encoded,
      ]);
    const bytes = await readFile(encoded);
    const f = fixture(async (url) => ({
      url,
      status: 200,
      headers: { 'content-type': speechMediaTypes[format] },
      body: bytes,
    }));
    const assets: { mimeType: string; path: string }[] = [];
    const tool = createSpeechTool(defaultSpeechConfig, {
      resolveModel: f.resolveModel,
      recordAsset: async (asset) => {
        assets.push(asset);
      },
    });
    const output = await runnable(tool)(
      { input: 'Hello', voice: 'alloy', response_format: format },
      { ...w, agent: scope },
    );
    assert.ok(output.file_path.endsWith(`.${format}`));
    assert.deepEqual(
      await readFile(join(w.directory, output.file_path)),
      bytes,
    );
    assert.ok(
      output.duration >= 1 && output.duration < 1.3,
      `${format}: ${output.duration}`,
    );
    assert.ok(output.sample_rate > 0);
    if (format === 'pcm') assert.equal(output.sample_rate, 24000);
    assert.equal(assets[0].mimeType, speechMediaTypes[format]);
    assert.equal(
      JSON.parse(String(f.calls[0][1].body)).response_format,
      format,
    );
  }
});

test('speech rejects mislabeled compressed responses instead of saving WAV bytes as MP3', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: f.resolveModel,
  });
  await assert.rejects(
    runnable(tool)(
      {
        input: 'Hello',
        voice: 'alloy',
        response_format: 'mp3',
        save_path: 'invalid.mp3',
      },
      w,
    ),
  );
  assert.equal(await w.workspace.filesystem!.exists('invalid.mp3'), false);
});

test('invalid workspace paths, mismatched extensions and existing outputs fail before generation', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  await w.workspace.filesystem!.writeFile('existing.wav', wav);
  const execute = runnable(
    createSpeechTool(defaultSpeechConfig, { resolveModel: f.resolveModel }),
  );
  for (const patch of [
    { save_path: '/tmp/out.wav' },
    { save_path: '../out.wav' },
    { save_path: 'out.mp3' },
    { save_path: 'existing.wav' },
  ])
    await assert.rejects(
      execute({ input: 'Hello', voice: 'alloy', ...patch }, w),
    );
  await assert.rejects(execute({ input: 'Hello', voice: 'alloy' }));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readFile(join(w.directory, 'existing.wav')), wav);
});

test('malformed audio, timeouts and upstream errors never save successful output or expose secrets', async (t) => {
  const w = await workspace(t);
  for (const body of [
    Buffer.from('<html>synthetic-secret</html>'),
    wav.subarray(0, 100),
    Buffer.alloc(0),
  ]) {
    const f = fixture(async (url) => ({
      url,
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body,
    }));
    await assert.rejects(
      runnable(
        createSpeechTool(defaultSpeechConfig, { resolveModel: f.resolveModel }),
      )({ input: 'Hello', voice: 'alloy' }, w),
      (error: Error) => {
        assert.doesNotMatch(error.message, /synthetic-secret/);
        assert.match(error.message, /Speech generation failed/);
        return true;
      },
    );
  }
  const f = fixture(async () => {
    throw new Error('Bearer synthetic-secret');
  });
  const execute = runnable(
    createSpeechTool(defaultSpeechConfig, { resolveModel: f.resolveModel }),
  );
  await assert.rejects(
    execute({ input: 'Hello', voice: 'alloy' }, w),
    (error: Error) => {
      assert.doesNotMatch(error.message, /synthetic-secret/);
      assert.match(error.message, /Speech generation failed/);
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
  const slow = fixture(
    async (_url, options) =>
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Test timeout')), 1500);
        options.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(options.signal.reason);
          },
          { once: true },
        );
      }),
  );
  await assert.rejects(
    runnable(
      createSpeechTool(
        { ...defaultSpeechConfig, timeoutMs: 1000 },
        { resolveModel: slow.resolveModel },
      ),
    )({ input: 'Hello', voice: 'alloy' }, w),
    /timed out/,
  );
});

test('WAV parser rejects empty and truncated chunks and reads actual duration', () => {
  assert.deepEqual(wavMetadata(wav), { duration: 1, sampleRate: 8000 });
  const empty = Buffer.from(wav);
  empty.writeUInt32LE(0, 40);
  assert.throws(() => wavMetadata(empty));
  assert.throws(() => wavMetadata(wav.subarray(0, 44)));
});

test('speech settings use the live default or explicit model and reject disabled or incorrectly typed models', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  const rows = new Map<string, { id: string; value: unknown }>();
  const database = {
    getRepository: () => ({
      findOneBy: async ({ id }: { id: string }) => rows.get(id),
      upsert: async (row: { id: string; value: unknown }) => {
        rows.set(row.id, row);
      },
    }),
  } as unknown as DataSource;
  const state = {
    selected: 'voices/alias',
    enabled: true,
    modelType: 'speech',
    providerEnabled: true,
  };
  const modelReferences: string[] = [];
  const providers: ConstructorParameters<typeof ToolService>[1] = {
    getProvider: async () => {
      throw new Error('Unused');
    },
    getDefaults: async () => ({
      ...emptyModelDefaults,
      speechModel: state.selected || null,
    }),
    getModel: async (reference) => {
      modelReferences.push(reference);
      return {
        enabled: state.enabled,
        modelType: state.modelType,
        name: 'VoxCPM2',
        modalitiesOutput: ['audio'],
      } as Awaited<ReturnType<typeof providers.getModel>>;
    },
    getProviderInstance: async () => {
      if (!state.providerEnabled) throw new Error('Disabled provider');
      return f.provider;
    },
  };
  const service = new ToolService(database, providers);
  assert.deepEqual((await service.get('speech')).config, defaultSpeechConfig);
  const built = (await service.buildTools(['speech'])).speech;
  assert.ok('execute' in built && built.execute);
  await built.execute(
    { input: 'Hello', voice: 'alloy', instructions: 'Happy' },
    w,
  );
  assert.equal(modelReferences.at(-1), 'voices/alias');
  assert.deepEqual(JSON.parse(JSON.parse(String(f.calls[0][1].body)).kwargs), {
    control_instruction: 'Happy',
  });
  state.selected = 'voices/changed';
  await built.execute({ input: 'Hello', voice: 'alloy' }, w);
  assert.equal(modelReferences.at(-1), state.selected);
  await service.update('speech', {
    ...defaultSpeechConfig,
    model: 'voices/fixed',
  });
  const explicit = (await service.buildTools(['speech'])).speech;
  assert.ok('execute' in explicit && explicit.execute);
  await explicit.execute({ input: 'Hello', voice: 'alloy' }, w);
  assert.equal(modelReferences.at(-1), 'voices/fixed');
  const callCount = f.calls.length;
  for (const patch of [
    { enabled: false },
    { modelType: 'language' },
    { providerEnabled: false },
  ]) {
    Object.assign(
      state,
      { enabled: true, modelType: 'speech', providerEnabled: true },
      patch,
    );
    await assert.rejects(
      service.update('speech', {
        ...defaultSpeechConfig,
        model: 'voices/fixed',
      }),
      { code: 'INVALID_SPEECH_MODEL' },
    );
    await assert.rejects(built.execute({ input: 'Hello', voice: 'alloy' }, w));
  }
  Object.assign(state, {
    enabled: true,
    modelType: 'speech',
    providerEnabled: true,
    selected: '',
  });
  await assert.rejects(
    built.execute({ input: 'Hello', voice: 'alloy' }, w),
    /default speech model/,
  );
  assert.equal(f.calls.length, callCount);
  await service.setEnabled('speech', false);
  assert.deepEqual(await service.buildTools(['speech']), {});
  assert.doesNotMatch(
    JSON.stringify([...rows.values()]),
    /synthetic-secret|apiKey/,
  );
  for (const patch of [
    { model: 'bare' },
    { timeoutMs: 600001 },
    { apiKey: 'no' },
  ])
    assert.equal(
      speechConfigSchema.safeParse({ ...defaultSpeechConfig, ...patch })
        .success,
      false,
    );
});

test('native Mastra streaming records audio with the actual tool call and project member identity', async (t) => {
  const w = await workspace(t);
  const f = fixture();
  const recorded: unknown[] = [];
  let step = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          if (step++ === 0)
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'native-speech-call',
              toolName: 'speech',
              input: JSON.stringify({ input: 'Hello', voice: 'alloy' }),
            });
          controller.enqueue({
            type: 'finish',
            finishReason: step === 1 ? 'tool-calls' : 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    }),
  });
  const agent = new Agent({
    id: 'speech-hook',
    name: 'Speech hook',
    instructions: 'Generate speech',
    model,
    workspace: w.workspace,
    memory: new Memory({
      storage: new InMemoryStore(),
      options: { generateTitle: false },
    }),
    tools: {
      speech: createSpeechTool(defaultSpeechConfig, {
        resolveModel: f.resolveModel,
        recordAsset: async (asset) => {
          recorded.push(asset);
        },
      }),
    },
  });
  const requestContext = new RequestContext();
  requestContext.set('userId', 'project-member');
  const stream = await agent.stream('Say hello', {
    requestContext,
    memory: { thread: 'native-thread', resource: 'project:project000000001' },
    maxSteps: 2,
  });
  await stream.consumeStream();
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    threadId: 'native-thread',
    resourceId: 'project:project000000001',
    createdBy: 'project-member',
    mimeType: 'audio/wav',
    size: wav.length,
    path: (recorded[0] as { path: string }).path,
    toolName: 'speech',
    toolCallId: 'native-speech-call',
    model: 'voices/VoxCPM2',
    metadata: { duration: 1, sampleRate: 8000 },
  });
});
