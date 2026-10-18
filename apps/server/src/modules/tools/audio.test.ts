import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath } from '../audio/binaries.js';
import type { Auth } from '@aime/auth';
import type { SpeechModel } from 'ai';
import { RequestContext } from '@mastra/core/request-context';
import {
  CompositeFilesystem,
  LocalFilesystem,
  Workspace,
} from '@mastra/core/workspace';
import type { ToolExecutionContext } from '@mastra/core/tools';
import {
  defaultSpeechConfig,
  defaultTranscriptionsConfig,
} from '@aime/shared/tools';
import { VoiceStore } from '../audio/voices.js';
import { AudioService } from '../audio/service.js';
import {
  normalizeTranscriptionAudio,
  normalizeVoiceAudio,
} from '../audio/convert.js';
import { audioRoutes } from '../audio/routes.js';
import { createSpeechTool } from '../../mastra/tools/speech.js';
import { createTranscriptionsTool } from '../../mastra/tools/transcriptions.js';
import { readAudioReference } from '../../mastra/tools/audio/context.js';
import { createListVoicesTool } from '../../mastra/tools/list_voices.js';
import { OpenAICompatibleProvider } from '../../mastra/providers/openai-compatible.js';
import { XinferenceProvider } from '../../mastra/providers/xinference.js';
import { wavMetadata } from '../../mastra/providers/audio-data.js';
import { transcriptionExcerpt } from '@aime/shared/audio';
import { buildTools } from './registry.js';

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

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'audio-tools-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const sample = {
  name: '旁白',
  description: '温暖低沉，适合故事旁白',
  text: '你好。\n这是样音。',
  shared: false,
};
function context(userId = 'alice'): ToolExecutionContext {
  const requestContext = new RequestContext();
  requestContext.set('userId', userId);
  return {
    requestContext,
    observe: { span: async (_name, operation) => operation(), log: () => {} },
  };
}
function service(
  root: string,
  config = defaultTranscriptionsConfig,
  transcript: Record<string, unknown> | string = {
    text: '自动识别的原文',
    language: 'zh',
  },
) {
  const transcriptions: FormData[] = [];
  const speechCalls: FormData[] = [];
  const speechPresets: { voice: string }[] = [];
  const modelReferences: (string | undefined)[] = [];
  const asr = new OpenAICompatibleProvider(
    {
      id: 'asr',
      type: 'openai',
      baseUrl: 'https://asr.example.test/v1',
      apiKey: 'synthetic-secret',
    },
    undefined,
    async (url, options) => {
      transcriptions.push(
        await new Response(new Uint8Array(Buffer.from(options.body!)), {
          headers: { 'Content-Type': options.headers!['content-type'] },
        }).formData(),
      );
      return {
        url,
        status: 200,
        headers: {
          'content-type':
            typeof transcript === 'string' ? 'text/plain' : 'application/json',
        },
        body: Buffer.from(
          typeof transcript === 'string'
            ? transcript
            : JSON.stringify(transcript),
        ),
      };
    },
  );
  const speech = new XinferenceProvider(
    { id: 'tts', baseUrl: 'https://tts.example.test' },
    async (url, options) => {
      if (options.headers!['content-type'].startsWith('multipart/'))
        speechCalls.push(
          await new Response(new Uint8Array(Buffer.from(options.body!)), {
            headers: { 'Content-Type': options.headers!['content-type'] },
          }).formData(),
        );
      else
        speechPresets.push(JSON.parse(Buffer.from(options.body!).toString()));
      return {
        url,
        status: 200,
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      };
    },
  );
  const audio = new AudioService(
    root,
    {
      getTranscriptionModel: async (reference) => {
        modelReferences.push(reference);
        return asr.transcriptionModel('test-asr');
      },
      getSpeechModel: async () => speech.speechModel('VoxCPM2'),
    },
    async () => config,
  );
  return {
    audio,
    transcriptions,
    speechCalls,
    speechPresets,
    modelReferences,
    speech,
  };
}

test('voices persist description and transcript; sharing moves the folder, keeps owner editing and cannot be reversed', async (t) => {
  const root = await fixture(t);
  const voices = new VoiceStore(root);
  const personal = await voices.create('alice', sample, wav);
  assert.match(
    personal.audioPath,
    /^users\/alice\/\.audios\/[^/]+\/voice.wav$/,
  );
  assert.equal(personal.description, sample.description);
  assert.equal(
    await readFile(join(root, personal.textPath), 'utf8'),
    sample.text,
  );
  assert.equal((await voices.list('bob')).length, 0);
  await assert.rejects(voices.readAudio('bob', personal.audioPath));
  const shared = await voices.update('alice', { ...personal, shared: true });
  assert.match(shared.audioPath, /^\.audios\/[^/]+\/voice.wav$/);
  await assert.rejects(stat(join(root, personal.audioPath)), {
    code: 'ENOENT',
  });
  assert.deepEqual(
    (await voices.readAudio('bob', shared.audioPath)).audio,
    wav,
  );
  assert.equal((await voices.list('bob'))[0].canEdit, false);
  await assert.rejects(voices.update('bob', { ...shared, shared: false }));
  await assert.rejects(voices.remove('bob', shared.audioPath));
  assert.equal(shared.canEdit, true);
  await assert.rejects(
    voices.update('alice', {
      ...shared,
      shared: false,
      text: 'must not be written',
    }),
    { code: 'AUDIO_SHARING_PERMANENT', status: 409 },
  );
  assert.deepEqual(await voices.get('alice', shared.audioPath), shared);
  assert.equal((await voices.list('bob')).length, 1);
  await assert.rejects(stat(join(root, personal.audioPath)), {
    code: 'ENOENT',
  });
  const metadata = JSON.parse(
    await readFile(join(root, dirname(shared.audioPath), 'voice.json'), 'utf8'),
  );
  assert.equal('shared' in metadata, false);
  const described = await voices.update('alice', {
    ...shared,
    description: '温暖'.repeat(2000),
  });
  assert.equal(described.description.length, 4000);
  assert.equal(
    (await voices.list('alice'))[0].description,
    described.description,
  );
  await voices.remove('alice', shared.audioPath);
  assert.deepEqual(await voices.list('alice'), []);
});

test('voice storage skips incomplete folders and rejects traversal and symlink reads or writes', async (t) => {
  const root = await fixture(t);
  const voices = new VoiceStore(root);
  const voice = await voices.create('alice', sample, wav);
  const partial = join(root, 'users/alice/.audios/partial');
  await mkdir(partial);
  await writeFile(join(partial, 'voice.wav'), wav);
  await symlink(
    dirname(join(root, voice.audioPath)),
    join(root, 'users/alice/.audios/link'),
  );
  assert.equal((await voices.list('alice')).length, 1);
  for (const path of [
    '../voice.wav',
    '/etc/passwd',
    'users/bob/.audios/test/voice.wav',
    'users/alice/.audios/link/voice.wav',
  ])
    await assert.rejects(voices.readAudio('alice', path));
  for (const id of [
    '',
    '../outside',
    'test/voice.wav',
    'link',
    'missing',
    'partial',
  ])
    await assert.rejects(voices.readAudioById('alice', id));
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, '.audios'));
  await assert.rejects(
    voices.create('alice', { ...sample, shared: true }, wav),
  );
  await assert.rejects(voices.update('alice', { ...voice, shared: true }));
  assert.equal((await voices.get('alice', voice.audioPath)).text, sample.text);
});

test('audio validation rejects malformed, oversized and cancelled input', async () => {
  await assert.rejects(normalizeVoiceAudio(Buffer.from('bad')));
  await assert.rejects(normalizeVoiceAudio(Buffer.alloc(0)));
  await assert.rejects(normalizeVoiceAudio(Buffer.alloc(20000001)));
  await assert.rejects(normalizeVoiceAudio(wav.subarray(0, 100)));
  await assert.rejects(normalizeVoiceAudio(wav, AbortSignal.abort()));
  assert.deepEqual(await normalizeVoiceAudio(wav), wav);
});

test('compressed uploads become real WAV', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'input.wav'), wav);
  assert.ok(ffmpegPath);
  await promisify(execFile)(ffmpegPath, [
    '-v',
    'error',
    '-i',
    join(root, 'input.wav'),
    join(root, 'input.mp3'),
  ]);
  const normalized = await normalizeVoiceAudio(
    await readFile(join(root, 'input.mp3')),
  );
  assert.ok(wavMetadata(normalized).duration >= 1);
  assert.equal(normalized.toString('ascii', 0, 4), 'RIFF');
});

test('speech resolves voice IDs across sharing changes, uses stored transcripts and isolates personal voices', async (t) => {
  const root = await fixture(t);
  const f = service(root, { ...defaultTranscriptionsConfig, enabled: false });
  const personal = await f.audio.voices.create('alice', sample, wav);
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: join(root, 'conversation') }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: async () => ({
      reference: 'tts/test',
      model: f.speech.speechModel('VoxCPM2'),
    }),
    audio: f.audio,
  });
  const call = (voice: string, userId = 'alice') =>
    tool.execute!(
      { input: '新的内容', voice },
      { ...context(userId), workspace },
    );
  const result = await call(personal.id);
  assert.ok(result && typeof result === 'object' && 'file_path' in result);
  assert.deepEqual(Object.keys(result).sort(), [
    'duration',
    'file_path',
    'sample_rate',
  ]);
  assert.equal(
    JSON.parse(String(f.speechCalls[0].get('kwargs'))).prompt_text,
    sample.text,
  );
  const reference = f.speechCalls[0].get('prompt_speech') as File;
  assert.deepEqual(Buffer.from(await reference.arrayBuffer()), wav);
  await call(personal.id, 'bob');
  assert.equal(f.speechPresets.at(-1)?.voice, personal.id);
  const shared = await f.audio.voices.update('alice', {
    ...personal,
    shared: true,
  });
  assert.equal(shared.id, personal.id);
  await call(personal.id, 'bob');
  await call(personal.id);
  await assert.rejects(
    f.audio.voices.update('alice', { ...shared, shared: false }),
    { code: 'AUDIO_SHARING_PERMANENT' },
  );
  await call(personal.id);
  await call(personal.id, 'bob');
  assert.equal(f.speechPresets.at(-1)?.voice, personal.id);
  assert.equal(f.speechPresets.length, 1);
  assert.equal(f.speechCalls[0].get('voice'), '');
  assert.equal(f.speechCalls.length, 5);
  assert.equal(f.transcriptions.length, 0);
});

test('speech uses one voice field for provider presets, including without a local library', async (t) => {
  const root = await fixture(t);
  const f = service(root);
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: join(root, 'conversation') }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  const received: (string | undefined)[] = [];
  const model: SpeechModel = {
    specificationVersion: 'v3',
    provider: 'openai.speech',
    modelId: 'test-speech',
    doGenerate: async ({ voice }) => {
      received.push(voice);
      return {
        audio: wav,
        warnings: [],
        response: { timestamp: new Date(), modelId: 'test-speech' },
      };
    },
  };
  for (const audio of [f.audio, undefined]) {
    const tool = createSpeechTool(defaultSpeechConfig, {
      resolveModel: async () => ({ reference: 'test/speech', model }),
      audio,
    });
    const legacyInput = await tool.inputSchema!['~standard'].validate({
      input: 'Hello',
      voice_id: 'preset-test',
    });
    assert.ok(legacyInput.issues);
    for (const voice of ['preset-test', 'provider:custom/preset', '']) {
      const result = await tool.execute!(
        { input: 'Hello', voice },
        { ...context(), workspace },
      );
      assert.ok(result && typeof result === 'object' && 'file_path' in result);
      assert.equal(received.at(-1), voice || undefined);
    }
  }
  assert.equal(received.length, 6);
  assert.equal(f.transcriptions.length, 0);
});

test('a local voice match takes precedence and incomplete samples never fall back to provider presets', async (t) => {
  const root = await fixture(t);
  const f = service(root);
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: join(root, 'conversation') }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  const personal = await f.audio.voices.create('alice', sample, wav);
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: async () => ({
      reference: 'test/speech',
      model: f.speech.speechModel('VoxCPM2'),
    }),
    audio: f.audio,
  });
  await tool.execute!(
    { input: 'Hello', voice: personal.id },
    { ...context(), workspace },
  );
  assert.equal(f.speechCalls.length, 1);
  assert.equal(f.speechCalls[0].get('voice'), '');
  await writeFile(join(root, personal.audioPath), 'broken WAV');
  await assert.rejects(
    tool.execute!(
      { input: 'Hello', voice: personal.id },
      { ...context(), workspace },
    ),
    /Could not read the saved voice/,
  );
  await rm(join(root, personal.textPath));
  await assert.rejects(
    tool.execute!(
      { input: 'Hello', voice: personal.id },
      { ...context(), workspace },
    ),
    /Could not read the saved voice/,
  );
  assert.equal(f.speechCalls.length, 1);
  assert.equal(f.speechPresets.length, 0);
});

test('voice ID lookup prefers the current user’s personal sample when a shared ID collides', async (t) => {
  const root = await fixture(t);
  const voices = new VoiceStore(root);
  const personal = await voices.create('alice', sample, wav);
  const sharedDirectory = join(root, '.audios', personal.id);
  await mkdir(sharedDirectory, { recursive: true });
  await writeFile(join(sharedDirectory, 'voice.wav'), wav);
  await writeFile(join(sharedDirectory, 'voice.txt'), '共享样音');
  assert.equal(
    (await voices.readAudioById('alice', personal.id)).text,
    sample.text,
  );
  assert.equal(
    (await voices.readAudioById('bob', personal.id)).text,
    '共享样音',
  );
});

test('ASR and voice tools register, propagate hints/config and enforce cancellation and disabled ASR', async (t) => {
  const f = service(await fixture(t), {
    ...defaultTranscriptionsConfig,
    model: 'configured/asr',
  });
  const voice = await f.audio.voices.create('alice', sample, wav);
  const tools = await buildTools(
    ['transcriptions', 'list_voices', 'speech'],
    {},
    { audio: f.audio },
  );
  assert.deepEqual(Object.keys(tools).sort(), [
    'list_voices',
    'speech',
    'transcriptions',
  ]);
  const recognized = await createTranscriptionsTool(
    defaultTranscriptionsConfig,
    f.audio,
  ).execute!(
    { file: voice.audioPath, language: 'zh', response_format: 'json' },
    context(),
  );
  assert.deepEqual(recognized, { text: '自动识别的原文', language: 'zh' });
  assert.equal(f.modelReferences[0], 'configured/asr');
  assert.equal(f.transcriptions[0].get('language'), 'zh');
  assert.equal(f.transcriptions[0].get('prompt'), null);
  assert.equal(f.transcriptions[0].get('response_format'), 'json');
  const listed = await createListVoicesTool(f.audio.voices).execute!(
    {},
    context(),
  );
  assert.ok(listed && 'voices' in listed);
  assert.equal(listed.voices[0].description, sample.description);
  assert.equal(
    await createTranscriptionsTool(defaultTranscriptionsConfig, f.audio)
      .execute!(
      { file: voice.audioPath, response_format: 'json' },
      { ...context(), abortSignal: AbortSignal.abort() },
    ),
    'Speech recognition was cancelled.',
  );
  assert.equal(f.transcriptions.length, 1);
  const disabled = service(await fixture(t), {
    ...defaultTranscriptionsConfig,
    enabled: false,
  });
  await assert.rejects(disabled.audio.transcribe(wav));
  assert.equal(disabled.transcriptions.length, 0);
});

test('transcriptions preserves all native verbose JSON fields and timestamps', async (t) => {
  const expected = {
    task: 'transcribe',
    text: '你好',
    language: 'chinese',
    duration: 1.01,
    segments: [
      {
        id: 0,
        seek: 0,
        text: '你好',
        start: 0,
        end: 1,
        tokens: [1, 2],
        temperature: 0,
        avg_logprob: -0.2,
        compression_ratio: 1.1,
        no_speech_prob: 0.01,
      },
    ],
    words: [{ word: '你好', start: 0, end: 1 }],
    usage: { type: 'duration', seconds: 2 },
  };
  const f = service(await fixture(t), defaultTranscriptionsConfig, expected);
  const voice = await f.audio.voices.create('alice', sample, wav);
  const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
  const result = await tool.execute!(
    { file: voice.audioPath, response_format: 'verbose_json' },
    context(),
  );
  assert.deepEqual(result, expected);
  assert.equal(f.transcriptions[0].get('response_format'), 'verbose_json');
  assert.deepEqual(await tool.outputSchema!['~standard'].validate(result), {
    value: expected,
  });
  assert.deepEqual(tool.toModelOutput!(expected), {
    type: 'text',
    value: JSON.stringify(expected),
  });
});

test('transcriptions returns native JSON or raw text/subtitles with no wrappers or fabricated fields', async (t) => {
  const responses = {
    json: {
      text: '你好',
      usage: {
        type: 'tokens',
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
      logprobs: [{ token: '你好', logprob: -0.1, bytes: [1, 2] }],
    },
    text: '你好\n',
    srt: '1\n00:00:00,000 --> 00:00:01,000\n你好\n\n',
    vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n\n',
  } as const;
  for (const format of ['json', 'text', 'srt', 'vtt'] as const) {
    await t.test(format, async () => {
      const expected = responses[format];
      const f = service(
        await fixture(t),
        defaultTranscriptionsConfig,
        expected,
      );
      const voice = await f.audio.voices.create('alice', sample, wav);
      const tool = createTranscriptionsTool(
        defaultTranscriptionsConfig,
        f.audio,
      );
      const result = await tool.execute!(
        { file: voice.audioPath, response_format: format },
        context(),
      );
      assert.deepEqual(result, expected);
      assert.equal(f.transcriptions[0].get('response_format'), format);
      assert.deepEqual(tool.toModelOutput!(expected), {
        type: 'text',
        value:
          typeof expected === 'string' ? expected : JSON.stringify(expected),
      });
    });
  }
  for (const transcript of [{ text: '' }, '']) {
    const f = service(
      await fixture(t),
      defaultTranscriptionsConfig,
      transcript,
    );
    const voice = await f.audio.voices.create('alice', sample, wav);
    const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
    assert.deepEqual(
      await tool.execute!(
        {
          file: voice.audioPath,
          response_format: typeof transcript === 'string' ? 'text' : 'json',
        },
        context(),
      ),
      transcript,
    );
  }
});

test('transcriptions accepts compact inputs and rejects missing verbose metadata', async (t) => {
  const f = service(await fixture(t), defaultTranscriptionsConfig, {
    text: '你好',
  });
  const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
  const parsed = await tool.inputSchema!['~standard'].validate({
    file: 'clip.mp4',
  });
  assert.deepEqual(parsed, {
    value: { file: 'clip.mp4', response_format: 'json' },
  });
  assert.deepEqual(
    await tool.inputSchema!['~standard'].validate({
      file: 'clip.mp4',
      response_format: 'srt',
      save_path: 'outputs/clip.srt',
    }),
    {
      value: {
        file: 'clip.mp4',
        response_format: 'srt',
        save_path: 'outputs/clip.srt',
      },
    },
  );
  for (const input of [
    { audio: 'clip.mp4' },
    { file: 'clip.mp4', prompt: 'context' },
    { file: 'clip.mp4', response_format: 'diarized_json' },
  ]) {
    assert.ok((await tool.inputSchema!['~standard'].validate(input)).issues);
  }
  const voice = await f.audio.voices.create('alice', sample, wav);
  await assert.rejects(
    tool.execute!(
      { file: voice.audioPath, response_format: 'verbose_json' },
      context(),
    ),
    /response_format/,
  );
  await assert.rejects(
    tool.execute!({ file: voice.audioPath, response_format: 'srt' }, context()),
    /response_format/,
  );
});

test('transcriptions saves each native response format without changing its return value', async (t) => {
  const cases = [
    {
      format: 'json',
      extension: 'json',
      output: { text: '你好', usage: { seconds: 1 } },
    },
    {
      format: 'verbose_json',
      extension: 'json',
      output: {
        text: '你好',
        language: 'zh',
        duration: 1,
        segments: [{ id: 0, start: 0, end: 1, text: '你好' }],
      },
    },
    { format: 'text', extension: 'txt', output: '你好\n第二行\n' },
    {
      format: 'srt',
      extension: 'srt',
      output: '1\r\n00:00:00,000 --> 00:00:01,000\r\n你好\r\n',
    },
    {
      format: 'vtt',
      extension: 'vtt',
      output: 'WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n',
    },
  ] as const;
  for (const { format, extension, output } of cases) {
    await t.test(format, async () => {
      const root = await fixture(t);
      const f = service(root, defaultTranscriptionsConfig, output);
      const workspace = new Workspace({
        filesystem: new LocalFilesystem({
          basePath: join(root, 'conversation'),
        }),
      });
      await workspace.init();
      t.after(() => workspace.destroy());
      await workspace.filesystem!.writeFile('input.wav', wav);
      const save_path = `outputs/transcriptions/结果.${extension}`;
      const result = await createTranscriptionsTool(
        defaultTranscriptionsConfig,
        f.audio,
      ).execute!(
        { file: 'input.wav', response_format: format, save_path },
        { ...context(), workspace },
      );
      assert.deepEqual(result, output);
      const saved = await readFile(
        join(root, 'conversation', save_path),
        'utf8',
      );
      if (typeof output === 'string') assert.equal(saved, output);
      else assert.deepEqual(JSON.parse(saved), output);
      assert.deepEqual(
        await readFile(join(root, 'conversation/input.wav')),
        wav,
      );
    });
  }
});

test('transcriptions optimizes only subtitle formats and saves the exact optimized response', async (t) => {
  const srt =
    '1\n00:00:00,000 --> 00:00:00,600\n我想要，\n\n2\n00:00:00,800 --> 00:00:02,000\n一杯奶茶，\n正常微冰，\n\n';
  const expectedSrt =
    '1\n00:00:00,000 --> 00:00:02,000\n我想要，一杯奶茶，正常微冰\n\n';
  const vtt = srt
    .replace(/^\d+\n/gm, '')
    .replaceAll(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  const json = {
    text: srt,
    language: 'zh',
    duration: 2,
    segments: [{ start: 0, end: 2, text: '换行，\n结尾逗号，' }],
  };
  const cases = [
    { format: 'srt', output: srt, expected: expectedSrt },
    {
      format: 'vtt',
      output: `WEBVTT\n\n${vtt}`,
      expected: `WEBVTT\n\n${expectedSrt.replace(/^\d+\n/gm, '').replaceAll(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`,
    },
    { format: 'text', output: srt, expected: srt },
    { format: 'json', output: json, expected: json },
    { format: 'verbose_json', output: json, expected: json },
  ] as const;
  for (const { format, output, expected } of cases) {
    await t.test(format, async () => {
      const root = await fixture(t);
      const f = service(root, defaultTranscriptionsConfig, output);
      const workspace = new Workspace({
        filesystem: new LocalFilesystem({
          basePath: join(root, 'conversation'),
        }),
      });
      await workspace.init();
      t.after(() => workspace.destroy());
      await workspace.filesystem!.writeFile('input.wav', wav);
      const extension =
        format === 'verbose_json' ? 'json' : format === 'text' ? 'txt' : format;
      const save_path = `outputs/optimized.${extension}`;
      const tool = createTranscriptionsTool(
        defaultTranscriptionsConfig,
        f.audio,
      );
      const result = await tool.execute!(
        { file: 'input.wav', response_format: format, save_path },
        { ...context(), workspace },
      );
      assert.deepEqual(result, expected);
      assert.deepEqual(tool.toModelOutput!(result!), {
        type: 'text',
        value: typeof result === 'string' ? result : JSON.stringify(result),
      });
      const saved = await readFile(
        join(root, 'conversation', save_path),
        'utf8',
      );
      if (typeof expected === 'string') assert.equal(saved, expected);
      else assert.deepEqual(JSON.parse(saved), expected);
    });
  }
});

test('long transcription model output keeps both ends while saved files and execution results remain complete in every format', async (t) => {
  const text = '开始' + '完整转录'.repeat(800) + '结束';
  const json = {
    text,
    language: 'zh',
    duration: 60,
    segments: Array.from({ length: 60 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: `第${i}句`,
    })),
    usage: { seconds: 60 },
  };
  for (const format of [
    'text',
    'srt',
    'vtt',
    'json',
    'verbose_json',
  ] as const) {
    await t.test(format, async () => {
      const output =
        format === 'json' || format === 'verbose_json'
          ? json
          : format === 'text'
            ? text
            : (format === 'vtt' ? 'WEBVTT\n\n' : '') +
              `1\n00:00:00${format === 'srt' ? ',' : '.'}000 --> 00:01:00${format === 'srt' ? ',' : '.'}000\n${text}\n\n`;
      const root = await fixture(t);
      const f = service(root, defaultTranscriptionsConfig, output);
      const workspace = new Workspace({
        filesystem: new LocalFilesystem({
          basePath: join(root, 'conversation'),
        }),
      });
      await workspace.init();
      t.after(() => workspace.destroy());
      await workspace.filesystem!.writeFile('input.wav', wav);
      const save_path = `full.${format === 'verbose_json' ? 'json' : format === 'text' ? 'txt' : format}`;
      const tool = createTranscriptionsTool(
        defaultTranscriptionsConfig,
        f.audio,
      );
      const result = await tool.execute!(
        { file: 'input.wav', response_format: format, save_path },
        { ...context(), workspace },
      );
      assert.ok(result && (typeof result === 'string' || 'text' in result));
      const full = typeof result === 'string' ? result : JSON.stringify(result);
      assert.ok(full.length > 2000);
      const expected = transcriptionExcerpt(result);
      assert.equal(expected.truncated, true);
      assert.equal(Array.from(expected.text).length, 2000);
      assert.deepEqual(tool.toModelOutput!(result!), {
        type: 'text',
        value: expected.text,
      });
      const saved = await readFile(
        join(root, 'conversation', save_path),
        'utf8',
      );
      if (typeof result === 'string') assert.equal(saved, result);
      else assert.deepEqual(JSON.parse(saved), json);
      assert.doesNotMatch(saved, /middle omitted/);
      if (format === 'text' || format === 'json' || format === 'verbose_json')
        assert.deepEqual(result, output);
    });
  }
});

test('transcription save paths reject invalid targets and never overwrite existing files', async (t) => {
  const root = await fixture(t);
  const f = service(root);
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: join(root, 'conversation') }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  const filesystem = workspace.filesystem!;
  await filesystem.writeFile('input.wav', wav);
  await filesystem.writeFile('existing.json', 'keep');
  const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
  const input = { file: 'input.wav', response_format: 'json' as const };
  for (const save_path of [
    '',
    '../outside.json',
    '/tmp/outside.json',
    'wrong.txt',
    'existing.json',
  ]) {
    await assert.rejects(
      tool.execute!({ ...input, save_path }, { ...context(), workspace }),
      /save_path/,
    );
  }
  await assert.rejects(
    tool.execute!({ ...input, save_path: 'result.json' }, context()),
    /workspace/,
  );
  assert.equal(f.transcriptions.length, 0);
  assert.equal(
    await filesystem.readFile('existing.json', { encoding: 'utf8' }),
    'keep',
  );

  const transcribe = f.audio.transcriptions.bind(f.audio);
  t.mock.method(
    f.audio,
    'transcriptions',
    async (...args: Parameters<typeof transcribe>) => {
      const result = await transcribe(...args);
      await filesystem.writeFile('race.json', 'another writer');
      return result;
    },
  );
  await assert.rejects(
    tool.execute!(
      { ...input, save_path: 'race.json' },
      { ...context(), workspace },
    ),
    /save_path/,
  );
  assert.equal(
    await filesystem.readFile('race.json', { encoding: 'utf8' }),
    'another writer',
  );
});

test('failed or cancelled transcription does not create an output file; symlink targets stay contained', async (t) => {
  const root = await fixture(t);
  const f = service(root, defaultTranscriptionsConfig, { text: 'not verbose' });
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: join(root, 'conversation') }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  await workspace.filesystem!.writeFile('input.wav', wav);
  const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
  await assert.rejects(
    tool.execute!(
      {
        file: 'input.wav',
        response_format: 'verbose_json',
        save_path: 'failed.json',
      },
      { ...context(), workspace },
    ),
  );
  assert.equal(await workspace.filesystem!.exists('failed.json'), false);
  assert.equal(
    await tool.execute!(
      {
        file: 'input.wav',
        response_format: 'json',
        save_path: 'cancelled.json',
      },
      { ...context(), workspace, abortSignal: AbortSignal.abort() },
    ),
    'Speech recognition was cancelled.',
  );
  assert.equal(await workspace.filesystem!.exists('cancelled.json'), false);
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'conversation/escape'));
  await assert.rejects(
    tool.execute!(
      {
        file: 'input.wav',
        response_format: 'json',
        save_path: 'escape/result.json',
      },
      { ...context(), workspace },
    ),
  );
  await assert.rejects(stat(join(root, 'outside/result.json')), {
    code: 'ENOENT',
  });
});

test('transcriptions saves through project mounts and rejects escaping mount symlinks', async (t) => {
  const root = await fixture(t);
  const f = service(root);
  const local = new LocalFilesystem({ basePath: join(root, 'mounted') });
  const workspace = new Workspace({
    filesystem: new CompositeFilesystem({ mounts: { '/project': local } }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  await local.writeFile('input.wav', wav);
  const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
  const input = { file: 'project/input.wav', response_format: 'json' as const };
  const result = await tool.execute!(
    { ...input, save_path: 'project/outputs/result.json' },
    { ...context(), workspace },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(root, 'mounted/outputs/result.json'), 'utf8'),
    ),
    result,
  );
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'mounted/escape'));
  await assert.rejects(
    tool.execute!(
      { ...input, save_path: 'project/escape/result.json' },
      { ...context(), workspace },
    ),
    /save_path/,
  );
  await assert.rejects(stat(join(root, 'outside/result.json')), {
    code: 'ENOENT',
  });
});

test('transcriptions extracts WAV from common video containers before sending it to ASR', async (t) => {
  const ffmpeg = ffmpegPath;
  assert.ok(ffmpeg);
  const root = await fixture(t);
  const f = service(root);
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: join(root, 'conversation') }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
  const run = (audio: string) =>
    tool.execute!(
      { file: audio, response_format: 'json' },
      { ...context(), workspace },
    );
  const formats = [
    ['mp4', 'mpeg4', 'aac'],
    ['mov', 'mpeg4', 'aac'],
    ['webm', 'libvpx', 'libopus'],
    ['mkv', 'ffv1', 'pcm_s16le'],
    ['avi', 'mpeg4', 'pcm_s16le'],
  ];
  for (const [extension, videoCodec, audioCodec] of formats) {
    await t.test(extension, async () => {
      const source = join(root, `input.${extension}`);
      await promisify(execFile)(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=32x32:r=5:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=1',
        '-c:v',
        videoCodec,
        '-c:a',
        audioCodec,
        source,
      ]);
      const bytes = await readFile(source);
      const path = `.uploads/clip.${extension}`;
      await workspace.filesystem!.writeFile(path, bytes);
      const result = await run(`/${path}`);
      assert.deepEqual(result, { text: '自动识别的原文', language: 'zh' });
      const file = f.transcriptions.at(-1)!.get('file') as File;
      assert.equal(file.type, 'audio/wav');
      const sent = Buffer.from(await file.arrayBuffer());
      assert.equal(wavMetadata(sent).sampleRate, 24000);
      assert.equal(sent.readUInt16LE(22), 1);
      assert.ok(Math.abs(wavMetadata(sent).duration - 1) < 0.1);
      assert.deepEqual(await workspace.filesystem!.readFile(path), bytes);
    });
  }

  await t.test(
    'video input may exceed both the voice sample and former 200 MiB limits',
    async () => {
      const mp4 = await readFile(join(root, 'input.mp4'));
      const padding = Buffer.alloc(200 * 1024 * 1024 + 1 - mp4.length);
      padding.writeUInt32BE(padding.length);
      padding.write('free', 4);
      const largeVideo = Buffer.concat([mp4, padding]);
      await workspace.filesystem!.writeFile('large.mp4', largeVideo);
      await assert.rejects(normalizeVoiceAudio(largeVideo), {
        code: 'AUDIO_TOO_LARGE',
      });
      await assert.rejects(
        readAudioReference(
          'large.mp4',
          { ...context(), workspace },
          {
            signal: new AbortController().signal,
          },
        ),
        { code: 'AUDIO_TOO_LARGE' },
      );
      const result = await run('large.mp4');
      assert.deepEqual(result, { text: '自动识别的原文', language: 'zh' });
    },
  );

  await t.test('only the first audio track is transcribed', async () => {
    const source = join(root, 'multiple.mkv');
    await promisify(execFile)(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=32x32:r=5:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=2',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-c:v',
      'ffv1',
      '-c:a',
      'pcm_s16le',
      source,
    ]);
    await workspace.filesystem!.writeFile(
      'multiple.mkv',
      await readFile(source),
    );
    const result = await run('multiple.mkv');
    assert.deepEqual(result, { text: '自动识别的原文', language: 'zh' });
    const file = f.transcriptions.at(-1)!.get('file') as File;
    assert.equal(
      wavMetadata(Buffer.from(await file.arrayBuffer())).duration,
      1,
    );
  });

  await t.test(
    'video with no audio track fails before calling ASR',
    async () => {
      const source = join(root, 'silent.mp4');
      await promisify(execFile)(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=32x32:r=5:d=1',
        '-c:v',
        'mpeg4',
        source,
      ]);
      await workspace.filesystem!.writeFile(
        'silent.mp4',
        await readFile(source),
      );
      const calls = f.transcriptions.length;
      await assert.rejects(run('silent.mp4'), /no audio track/);
      assert.equal(f.transcriptions.length, calls);
    },
  );

  for (const extension of ['flac', 'mp4']) {
    await t.test(
      `long ${extension} sends its complete audio beyond 20 MB and 50 MB`,
      async () => {
        const source = join(root, `long.${extension}`);
        await promisify(execFile)(ffmpeg, [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=24000:cl=mono',
          '-t',
          '1200',
          '-c:a',
          extension === 'flac' ? 'flac' : 'aac',
          source,
        ]);
        await workspace.filesystem!.writeFile(
          `long.${extension}`,
          await readFile(source),
        );
        const result = await run(`long.${extension}`);
        assert.deepEqual(result, { text: '自动识别的原文', language: 'zh' });
        const file = f.transcriptions.at(-1)!.get('file') as File;
        const sent = Buffer.from(await file.arrayBuffer());
        assert.ok(sent.length > 50_000_000);
        assert.ok(Math.abs(wavMetadata(sent).duration - 1200) < 0.1);
        assert.equal(await normalizeTranscriptionAudio(sent), sent);
        await assert.rejects(normalizeVoiceAudio(sent), {
          code: 'AUDIO_TOO_LARGE',
        });
      },
    );
  }
});

test('transcription media reader disables URL size caps while preserving cancellation and workspace containment', async (t) => {
  const signal = new AbortController().signal;
  const reference = await readAudioReference(
    'https://media.example.test/clip.mp4',
    undefined,
    {
      signal,
      maxBytes: Infinity,
      request: async (url, options) => {
        assert.equal(options.maxBytes, Infinity);
        assert.equal(options.signal, signal);
        return { url, status: 200, headers: {}, body: wav };
      },
    },
  );
  assert.deepEqual(reference.audio, wav);
  await assert.rejects(normalizeTranscriptionAudio(wav, AbortSignal.abort()));
  for (const bytes of [
    Buffer.from('#EXTM3U\nhttps://example.test/secret'),
    Buffer.from('https://example.test/clip.mp4'),
  ])
    await assert.rejects(normalizeTranscriptionAudio(bytes), {
      code: 'AUDIO_INVALID',
    });

  const root = await fixture(t);
  const basePath = join(root, 'conversation');
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath }),
  });
  await workspace.init();
  t.after(() => workspace.destroy());
  await writeFile(join(root, 'outside.mp4'), wav);
  await symlink(join(root, 'outside.mp4'), join(basePath, 'escape.mp4'));
  const f = service(root);
  const tool = createTranscriptionsTool(defaultTranscriptionsConfig, f.audio);
  for (const audio of ['../outside.mp4', 'escape.mp4'])
    await assert.rejects(
      tool.execute!(
        { file: audio, response_format: 'json' },
        { ...context(), workspace },
      ),
    );
  assert.equal(f.transcriptions.length, 0);
});

test('voice HTTP routes enforce sessions/origin/owner and support upload, ASR, generation, playback, sharing and deletion', async (t) => {
  const root = await fixture(t);
  const f = service(root);
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return id ? { user: { id } } : null;
      },
    },
  } as unknown as Auth;
  const origin = 'http://localhost:5173';
  const app = audioRoutes(auth, f.audio, [origin]);
  const headers = { 'x-test-user': 'alice', Origin: origin };
  assert.equal((await app.request('/voices')).status, 401);
  assert.equal(
    (
      await app.request('/voices', {
        method: 'POST',
        headers: { 'x-test-user': 'alice' },
      })
    ).status,
    403,
  );
  const body = new FormData();
  body.set('audio', new File([wav], 'sample.wav'));
  body.set('name', sample.name);
  body.set('description', sample.description);
  body.set('text', sample.text);
  const uploaded = await app.request('/voices', {
    method: 'POST',
    headers,
    body,
  });
  assert.equal(uploaded.status, 200);
  const voice = await uploaded.json();
  assert.equal(voice.description, sample.description);
  const raw = `/voices/raw?${new URLSearchParams({ path: voice.audioPath })}`;
  const playback = await app.request(raw, { headers });
  assert.equal(playback.status, 200);
  assert.equal(playback.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), wav);
  assert.equal(
    (await app.request(raw, { headers: { 'x-test-user': 'bob' } })).status,
    403,
  );
  const recognized = await app.request('/transcribe', {
    method: 'POST',
    headers,
    body,
  });
  assert.equal(recognized.status, 200);
  assert.equal((await recognized.json()).text, '自动识别的原文');
  const generated = await app.request('/voices/generate', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(sample),
  });
  assert.equal(generated.status, 200);
  const sharedResponse = await app.request('/voices', {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...voice, shared: true }),
  });
  assert.equal(sharedResponse.status, 200);
  const shared = await sharedResponse.json();
  const unsharedResponse = await app.request('/voices', {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...shared, shared: false }),
  });
  assert.equal(unsharedResponse.status, 409);
  assert.equal((await unsharedResponse.json()).code, 'AUDIO_SHARING_PERMANENT');
  const bob = await app.request('/voices', {
    headers: { 'x-test-user': 'bob' },
  });
  assert.equal((await bob.json()).voices.length, 1);
  const query = `/voices?${new URLSearchParams({ path: shared.audioPath })}`;
  assert.equal(
    (
      await app.request(query, {
        method: 'DELETE',
        headers: { ...headers, 'x-test-user': 'bob' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.request(query, { method: 'DELETE', headers })).status,
    200,
  );
});
