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
import type { Auth } from '@aime/auth';
import type { SpeechModel } from 'ai';
import { RequestContext } from '@mastra/core/request-context';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import type { ToolExecutionContext } from '@mastra/core/tools';
import {
  defaultSpeechConfig,
  defaultTranscribeConfig,
} from '@aime/shared/tools';
import { VoiceStore } from '../audio/voices.js';
import { AudioService } from '../audio/service.js';
import { normalizeVoiceAudio } from '../audio/convert.js';
import { audioRoutes } from '../audio/routes.js';
import { createSpeechTool } from '../../mastra/tools/speech.js';
import { createTranscribeTool } from '../../mastra/tools/transcribe.js';
import { createListVoicesTool } from '../../mastra/tools/list_voices.js';
import { OpenAICompatibleProvider } from '../../mastra/providers/openai-compatible.js';
import { XinferenceProvider } from '../../mastra/providers/xinference.js';
import { wavMetadata } from '../../mastra/providers/audio-data.js';
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
  config = defaultTranscribeConfig,
  transcript: Record<string, unknown> = {
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
        headers: {},
        body: Buffer.from(JSON.stringify(transcript)),
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
  try {
    await promisify(execFile)('ffmpeg', ['-version']);
  } catch {
    t.skip('ffmpeg unavailable');
    return;
  }
  await promisify(execFile)('ffmpeg', [
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
  const f = service(root, { ...defaultTranscribeConfig, enabled: false });
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
  assert.ok(result && 'file_path' in result);
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
      assert.ok(result && 'file_path' in result);
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
    ...defaultTranscribeConfig,
    model: 'configured/asr',
  });
  const voice = await f.audio.voices.create('alice', sample, wav);
  const tools = await buildTools(
    ['transcribe', 'list_voices', 'speech'],
    {},
    { audio: f.audio },
  );
  assert.deepEqual(Object.keys(tools).sort(), [
    'list_voices',
    'speech',
    'transcribe',
  ]);
  const recognized = await createTranscribeTool(
    defaultTranscribeConfig,
    f.audio,
  ).execute!(
    { audio: voice.audioPath, language: 'zh', prompt: '人名' },
    context(),
  );
  assert.deepEqual(recognized, { text: '自动识别的原文', duration: 1 });
  assert.equal(f.modelReferences[0], 'configured/asr');
  assert.equal(f.transcriptions[0].get('language'), 'zh');
  assert.equal(f.transcriptions[0].get('prompt'), '人名');
  const listed = await createListVoicesTool(f.audio.voices).execute!(
    {},
    context(),
  );
  assert.ok(listed && 'voices' in listed);
  assert.equal(listed.voices[0].description, sample.description);
  await assert.rejects(
    createTranscribeTool(defaultTranscribeConfig, f.audio).execute!(
      { audio: voice.audioPath },
      { ...context(), abortSignal: AbortSignal.abort() },
    ),
    /cancelled or timed out/,
  );
  assert.equal(f.transcriptions.length, 1);
  const disabled = service(await fixture(t), {
    ...defaultTranscribeConfig,
    enabled: false,
  });
  await assert.rejects(disabled.audio.transcribe(wav));
  assert.equal(disabled.transcriptions.length, 0);
});

test('transcribe keeps optional timestamps and only exposes text, actual duration and segments', async (t) => {
  const f = service(await fixture(t), defaultTranscribeConfig, {
    text: '你好',
    language: 'zh',
    duration: 999,
    segments: [{ text: '你好', start: 0, end: 1 }],
  });
  const voice = await f.audio.voices.create('alice', sample, wav);
  const tool = createTranscribeTool(defaultTranscribeConfig, f.audio);
  const result = await tool.execute!({ audio: voice.audioPath }, context());
  const expected = {
    text: '你好',
    duration: 1,
    segments: [{ text: '你好', startSecond: 0, endSecond: 1 }],
  };
  assert.deepEqual(result, expected);
  assert.deepEqual(tool.toModelOutput!(expected), {
    type: 'text',
    value: JSON.stringify(expected),
  });
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
