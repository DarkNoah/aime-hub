import { eventStream } from '../threads/event-stream.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestContext } from '@mastra/core/request-context';
import { defaultSpeechConfig } from '@aime/shared/tools';
import type { SpeechEvent } from '@aime/shared/audio';
import { SpeechPlayback } from '../audio/playback.js';
import { createSpeechTool } from '../../mastra/tools/speech.js';
import { createSpeechModel } from '../../mastra/providers/openai-compatible-speech.js';
import { supportsSpeechStreaming } from '../../mastra/providers/speech-model.js';
import { OpenAICompatibleProvider } from '../../mastra/providers/openai-compatible.js';
import {
  SpeechPlayer,
  type SpeechPlaybackState,
} from '../../../../web/src/components/audio/speech-player.js';
import { ThreadService } from '../threads/service.js';
import { ThreadError } from '../threads/errors.js';
import type { ChatSessionContext } from '../threads/session.js';
import { sessionStub } from '../../../../../scripts/fixtures/thread-session.js';
import { fakeMemory } from '../../../../../scripts/fixtures/thread-memory.js';

const pcm = {
  encoding: 'pcm_s16le' as const,
  mimeType: 'audio/pcm',
  sampleRate: 24000,
  channels: 1,
};
const provider = {
  id: 'local',
  type: 'openai',
  baseUrl: 'https://speech.example/v1',
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const scope = {
  agentId: 'agent',
  toolCallId: 'call',
  messages: [],
  suspend: async () => {},
  threadId: 'thread0000000001',
  resourceId: 'user:owner',
};
type Execute = NonNullable<ReturnType<typeof createSpeechTool>['execute']>;
const observe: Parameters<Execute>[1]['observe'] = {
  span: async (_name, fn) => fn(),
  log: () => {},
};

test('OpenAI-compatible speech marks streaming from model metadata, sends PCM chunks before completion and keeps buffered fallback', async () => {
  const requests: Record<string, unknown>[] = [];
  const gate = deferred();
  const model = createSpeechModel(
    provider,
    'custom-tts',
    { metadata: { speechStreaming: true, speechDefaultVoice: 'zh-female' } },
    async (url, options) => {
      requests.push(JSON.parse(String(options.body)));
      return {
        url,
        status: 200,
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('wav'),
      };
    },
    async (url, options, consumer) => {
      assert.equal(url, 'https://speech.example/v1/audio/speech');
      requests.push(JSON.parse(String(options.body)));
      consumer.response({
        url,
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
      });
      await consumer.chunk(new Uint8Array([1, 2]));
      await gate.promise;
      await consumer.chunk(new Uint8Array([3, 4]));
    },
  );
  assert.ok(supportsSpeechStreaming(model));
  const chunks: Uint8Array[] = [];
  const done = model.streamSpeech(
    {
      text: 'hello',
      instructions: 'calm',
      speed: 1.2,
      abortSignal: new AbortController().signal,
    },
    async (chunk) => {
      chunks.push(chunk.data);
    },
  );
  await delay(0);
  assert.equal(chunks.length, 1);
  assert.deepEqual(requests[0], {
    model: 'custom-tts',
    input: 'hello',
    instructions: 'calm',
    speed: 1.2,
    voice: 'zh-female',
    response_format: 'pcm',
    stream: true,
  });
  gate.resolve();
  await done;
  assert.equal(chunks.length, 2);
  await model.doGenerate({ text: 'save', outputFormat: 'wav' });
  assert.equal(requests[1].stream, false);
  assert.equal(requests[1].voice, 'zh-female');
  assert.equal(
    supportsSpeechStreaming(createSpeechModel(provider, 'other')),
    false,
  );
  assert.ok(
    supportsSpeechStreaming(
      new OpenAICompatibleProvider(provider).speechModel('custom-tts', {
        metadata: { speechStreaming: true },
      }),
    ),
  );
});

test('immediate speech returns before model resolution, streams after the tool abort signal ends, and never saves assets', async () => {
  const events: SpeechEvent[] = [];
  const playback = new SpeechPlayback((event) => {
    events.push(event);
  });
  const requestContext = new RequestContext();
  requestContext.set('speechPlayback', playback);
  const gate = deferred();
  let saved = 0;
  const model = createSpeechModel(
    provider,
    'tts',
    { metadata: { speechStreaming: true } },
    undefined,
    async (_url, _options, consumer) => {
      consumer.response({
        url: '',
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
      });
      await consumer.chunk(new Uint8Array(60000));
    },
  );
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: async () => {
      await gate.promise;
      return { reference: 'local/tts', model };
    },
    recordAsset: async () => {
      saved++;
    },
  });
  const controller = new AbortController();
  const output = await tool.execute!(
    {
      input: 'speak now',
      voice: 'zh-female',
      play_immediately: true,
      save_path: '../ignored.wav',
    },
    {
      requestContext,
      agent: scope,
      abortSignal: controller.signal,
      observe,
    },
  );
  assert.ok(
    output &&
      typeof output === 'object' &&
      'status' in output &&
      output.status === 'queued',
  );
  assert.equal(playback.active, true);
  assert.equal(
    events.some((event) => event.phase === 'chunk'),
    false,
  );
  controller.abort(); // LLM/tool lifetime must not truncate the session-owned job.
  gate.resolve();
  await playback.settled();
  assert.equal(saved, 0);
  assert.equal(playback.active, false);
  assert.deepEqual(
    events.map((event) => event.phase),
    ['start', 'chunk', 'chunk', 'chunk', 'end'],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [0, 1, 2, 3, 4],
  );
  for (const event of events) {
    assert.equal(event.text, 'speak now');
    assert.equal(event.toolCallId, 'call');
    if (event.phase === 'chunk') assert.ok(event.audio.length <= 32768);
  }
});

test('nonstreaming speech emits one complete file only after generation; no chat session fails clearly', async () => {
  const events: SpeechEvent[] = [];
  const playback = new SpeechPlayback((event) => {
    events.push(event);
  });
  const requestContext = new RequestContext();
  requestContext.set('speechPlayback', playback);
  const gate = deferred();
  const model = createSpeechModel(provider, 'buffered', {}, async (url) => {
    await gate.promise;
    return {
      url,
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('complete wav'),
    };
  });
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: async () => ({ reference: 'local/buffered', model }),
  });
  await tool.execute!(
    { input: 'fallback', voice: 'alloy', play_immediately: true },
    { requestContext, observe },
  );
  await delay(0);
  assert.deepEqual(
    events.map((event) => event.phase),
    ['start'],
  );
  gate.resolve();
  await playback.settled();
  const chunk = events.find((event) => event.phase === 'chunk');
  assert.ok(chunk?.phase === 'chunk');
  assert.equal(chunk.encoding, 'file');
  assert.equal(Buffer.from(chunk.audio, 'base64').toString(), 'complete wav');
  assert.equal(events.at(-1)?.phase, 'end');
  await assert.rejects(
    () =>
      tool.execute!(
        { input: 'no session', voice: 'alloy', play_immediately: true },
        { observe },
      ),
    /active chat session/,
  );
});

test('speech queue preserves ordering, cancels pending and active work, sanitizes errors and closes permanently', async () => {
  const events: SpeechEvent[] = [];
  const playback = new SpeechPlayback((event) => {
    events.push(event);
  });
  const started = deferred();
  playback.start({
    text: 'first',
    timeoutMs: 1000,
    generate: async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  });
  playback.start({
    text: 'second',
    timeoutMs: 1000,
    generate: async () => {
      assert.fail('cancelled queue must not generate');
    },
  });
  await started.promise;
  playback.stop();
  await playback.settled();
  assert.deepEqual(
    events.map((event) => [event.text, event.phase]),
    [
      ['first', 'start'],
      ['first', 'cancelled'],
      ['second', 'cancelled'],
    ],
  );
  playback.start({
    text: 'third',
    timeoutMs: 1000,
    generate: async () => {
      throw new Error('secret provider body');
    },
  });
  await playback.settled();
  assert.equal(events.at(-1)?.phase, 'error');
  assert.ok(!JSON.stringify(events).includes('secret'));
  await playback.close();
  assert.throws(
    () =>
      playback.start({
        text: 'late',
        timeoutMs: 1000,
        generate: async () => {},
      }),
    /closed/,
  );
});

class FakeAudio {
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  destination = {};
  analyser = {
    fftSize: 1024,
    frequencyBinCount: 512,
    smoothingTimeConstant: 0,
    minDecibels: 0,
    maxDecibels: 0,
    connections: [] as unknown[],
    frequencies: new Uint8Array(512),
    disconnected: false,
    reads: 0,
    connect(target: unknown) {
      this.connections.push(target);
    },
    disconnect() {
      this.disconnected = true;
    },
    getByteFrequencyData(output: Uint8Array) {
      this.reads++;
      output.set(this.frequencies);
    },
  };
  onstatechange?: () => void;
  sources: {
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    stopped: boolean;
    startTime: number;
    start: (time: number) => void;
    stop: () => void;
    connections: unknown[];
    connect: (target: unknown) => void;
    disconnect: () => void;
  }[] = [];
  decoded: ArrayBuffer[] = [];
  async resume() {
    this.onstatechange?.();
  }
  async close() {
    this.state = 'closed';
  }
  createAnalyser() {
    return this.analyser;
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
    return {
      duration: length / sampleRate,
      getChannelData: (channel: number) => data[channel],
    } as AudioBuffer;
  }
  createBufferSource() {
    const source = {
      buffer: null as AudioBuffer | null,
      onended: null as (() => void) | null,
      stopped: false,
      startTime: 0,
      start(time: number) {
        this.startTime = time;
      },
      stop() {
        this.stopped = true;
      },
      connections: [] as unknown[],
      connect(target: unknown) {
        this.connections.push(target);
      },
      disconnect() {},
    };
    this.sources.push(source);
    return source;
  }
  async decodeAudioData(bytes: ArrayBuffer) {
    this.decoded.push(bytes);
    return this.createBuffer(1, 24, 24000);
  }
}
function playerFixture() {
  const audio = new FakeAudio();
  const states: SpeechPlaybackState[] = [];
  let errors = 0;
  const player = new SpeechPlayer(
    (state) => states.push(state),
    () => {
      errors++;
    },
    () => audio as unknown as AudioContext,
  );
  const base = (id: string, sequence: number) => ({
    playbackId: id,
    text: `text ${id}`,
    sequence,
  });
  return {
    audio,
    states,
    player,
    base,
    get errors() {
      return errors;
    },
  };
}

test('player analyses the single audible output and clears the spectrum when silent, blocked or stopped', () => {
  const f = playerFixture();
  const levels = new Float32Array(15).fill(1);
  f.player.readSpectrum(levels);
  assert.ok(levels.every((value) => value === 0));
  assert.equal(f.audio.analyser.connections.length, 0);

  f.player.receive({ ...f.base('a', 0), phase: 'start' });
  f.player.receive({
    ...f.base('a', 1),
    phase: 'chunk',
    ...pcm,
    audio: 'AAA=',
  });
  assert.deepEqual(f.audio.sources[0].connections, [f.audio.analyser]);
  assert.deepEqual(f.audio.analyser.connections, [f.audio.destination]);
  f.audio.analyser.frequencies.fill(255, 8, 16);
  f.player.readSpectrum(levels);
  assert.ok(levels.some((value) => value > 0));
  assert.ok(levels.every((value) => value >= 0 && value <= 1));
  assert.equal(levels[14], 0);

  f.audio.analyser.frequencies.fill(0);
  f.player.readSpectrum(levels);
  assert.ok(levels.every((value) => value === 0));
  f.audio.analyser.frequencies.fill(255);
  f.audio.state = 'suspended';
  f.player.readSpectrum(levels);
  assert.ok(levels.every((value) => value === 0));
  f.audio.state = 'running';
  f.player.readSpectrum(levels);
  assert.ok(levels.every((value) => value === 1));

  f.player.stop();
  f.player.readSpectrum(levels);
  assert.ok(levels.every((value) => value === 0));
  const reads = f.audio.analyser.reads;
  f.player.dispose();
  f.player.readSpectrum(levels);
  assert.equal(f.audio.analyser.reads, reads);
  assert.equal(f.audio.analyser.disconnected, true);
  assert.equal(f.audio.state, 'closed');
});

test('player joins odd PCM boundaries, converts signed little-endian samples and serializes utterances', () => {
  const f = playerFixture();
  f.player.receive({ ...f.base('a', 0), phase: 'start' });
  f.player.receive({
    ...f.base('a', 1),
    phase: 'chunk',
    ...pcm,
    audio: Buffer.from([0]).toString('base64'),
  });
  assert.equal(f.audio.sources.length, 0);
  f.player.receive({
    ...f.base('a', 2),
    phase: 'chunk',
    ...pcm,
    audio: Buffer.from([128, 255, 127]).toString('base64'),
  });
  f.player.receive({ ...f.base('a', 3), phase: 'end' });
  assert.deepEqual(
    [...f.audio.sources[0].buffer!.getChannelData(0)],
    [-1, 32767 / 32768],
  );
  f.player.receive({ ...f.base('b', 0), phase: 'start' });
  f.player.receive({
    ...f.base('b', 1),
    phase: 'chunk',
    ...pcm,
    audio: 'AAA=',
  });
  f.player.receive({ ...f.base('b', 2), phase: 'end' });
  assert.equal(f.audio.sources.length, 1);
  assert.equal(f.states.at(-1)?.text, 'text a');
  f.audio.sources[0].onended!();
  assert.equal(f.audio.sources.length, 2);
  assert.equal(f.states.at(-1)?.text, 'text b');
  f.audio.sources[1].onended!();
  assert.equal(f.states.at(-1), null);
  assert.equal(f.errors, 0);
  f.player.dispose();
});

test('player decodes completed fallback only on end and shows blocked playback until resumed', async () => {
  const f = playerFixture();
  f.audio.state = 'suspended';
  f.player.receive({ ...f.base('a', 0), phase: 'start' });
  f.player.receive({
    ...f.base('a', 1),
    phase: 'chunk',
    encoding: 'file',
    mimeType: 'audio/wav',
    audio: 'AQI=',
  });
  f.player.receive({
    ...f.base('a', 2),
    phase: 'chunk',
    encoding: 'file',
    mimeType: 'audio/wav',
    audio: 'AwQ=',
  });
  assert.equal(f.audio.decoded.length, 0);
  f.player.receive({ ...f.base('a', 3), phase: 'end' });
  await delay(0);
  assert.deepEqual([...new Uint8Array(f.audio.decoded[0])], [1, 2, 3, 4]);
  assert.equal(f.states.at(-1)?.status, 'blocked');
  f.audio.state = 'running';
  f.player.unlock();
  assert.equal(f.states.at(-1)?.status, 'playing');
  f.player.stop();
  assert.equal(f.audio.sources[0].stopped, true);
  assert.equal(f.states.at(-1), null);
  f.player.dispose();
});

test('player ignores replay/partial reconnect audio and stops on missing chunks or incomplete PCM', () => {
  const f = playerFixture();
  f.player.receive({
    ...f.base('unknown', 4),
    phase: 'chunk',
    ...pcm,
    audio: 'AAA=',
  });
  assert.equal(f.audio.sources.length, 0);
  f.player.receive({ ...f.base('a', 0), phase: 'start' });
  f.player.receive({
    ...f.base('a', 2),
    phase: 'chunk',
    ...pcm,
    audio: 'AAA=',
  });
  assert.equal(f.errors, 1);
  f.player.receive({ ...f.base('a', 0), phase: 'start' });
  assert.equal(f.states.at(-1), null);
  f.player.receive({ ...f.base('b', 0), phase: 'start' });
  f.player.receive({
    ...f.base('b', 1),
    phase: 'chunk',
    ...pcm,
    audio: 'AA==',
  });
  f.player.receive({ ...f.base('b', 2), phase: 'end' });
  assert.equal(f.errors, 2);
  f.player.dispose();
});

const settings = { model: null, reasoningEffort: 'auto' } as const;
test('thread speech events are ephemeral, survive successful model completion, authorize listeners, and stop separately', async (t) => {
  const memory = fakeMemory();
  let context!: ChatSessionContext;
  let playback!: SpeechPlayback;
  let aborted = false;
  const service = new ThreadService(memory.memory, {
    async validate() {},
    async createWorkspace() {
      return '/tmp/test-speech';
    },
    async open(value) {
      context = value;
      playback = new SpeechPlayback((event) =>
        context.onEvent({ type: 'speech', event }),
      );
      return sessionStub({
        speech: playback,
        abort() {
          aborted = true;
          playback.stop();
        },
        close: () => playback.close(),
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, {
    ...settings,
    id: 'input001',
    isImmediate: false,
    parts: [{ type: 'text', text: 'hello' }],
  });
  const events: SpeechEvent[] = [];
  const snapshots: unknown[] = [];
  const unsubscribe = await service.subscribe(
    'alice',
    thread.id,
    (snapshot) => snapshots.push(snapshot),
    undefined,
    (event) => {
      events.push(event);
    },
  );
  t.after(unsubscribe);
  await assert.rejects(
    () =>
      service.subscribe(
        'bob',
        thread.id,
        () => {},
        undefined,
        () => assert.fail(),
      ),
    ThreadError,
  );
  await context.onEvent({
    type: 'status',
    status: 'success',
    runId: 'input001',
  });
  playback.start({
    text: 'later',
    timeoutMs: 1000,
    generate: async (_signal, emit) => {
      await emit({ ...pcm, data: new Uint8Array([0, 1]) });
    },
  });
  await playback.settled();
  assert.deepEqual(
    events.map((event) => event.phase),
    ['start', 'chunk', 'end'],
  );
  assert.ok(!JSON.stringify(snapshots).includes('pcm_s16le'));
  const replay: SpeechEvent[] = [];
  (
    await service.subscribe(
      'alice',
      thread.id,
      () => {},
      undefined,
      (event) => {
        replay.push(event);
      },
    )
  )();
  assert.equal(replay.length, 0);
  const started = deferred();
  playback.start({
    text: 'stop',
    timeoutMs: 1000,
    generate: async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  });
  await started.promise;
  await assert.rejects(() => service.stopSpeech('bob', thread.id), ThreadError);
  await service.stopSpeech('alice', thread.id);
  await playback.settled();
  assert.equal(aborted, false);
  assert.equal(events.at(-1)?.phase, 'cancelled');
});

test(
  'live OpenAI-compatible PCM speech reaches playback events before generation completes',
  { skip: !process.env.SPEECH_STREAM_TEST_URL },
  async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'live',
      type: 'openai',
      baseUrl: process.env.SPEECH_STREAM_TEST_URL!,
    });
    const model = provider.speechModel('cosyvoice3-0.5b', {
      metadata: { speechStreaming: true, speechDefaultVoice: 'zh-female' },
    });
    assert.ok(supportsSpeechStreaming(model));
    const started = Date.now();
    const times: { phase: string; ms: number }[] = [];
    let bytes = 0;
    const playback = new SpeechPlayback((event) => {
      times.push({ phase: event.phase, ms: Date.now() - started });
      if (event.phase === 'chunk') {
        bytes += Buffer.from(event.audio, 'base64').length;
        assert.equal(event.sampleRate, 24000);
      }
    });
    const requestContext = new RequestContext();
    requestContext.set('speechPlayback', playback);
    const tool = createSpeechTool(defaultSpeechConfig, {
      resolveModel: async () => ({ reference: 'live/cosyvoice3-0.5b', model }),
      recordAsset: async () => assert.fail('Playback must not save an asset'),
    });
    const result = await tool.execute!(
      {
        input: '你好，现在测试边生成边返回语音。',
        voice: 'zh-female',
        play_immediately: true,
      },
      { requestContext, observe },
    );
    const returnedMs = Date.now() - started;
    assert.ok(
      result &&
        typeof result === 'object' &&
        'status' in result &&
        result.status === 'queued',
    );
    await playback.settled();
    assert.equal(times.at(-1)?.phase, 'end');
    const first = times.find((event) => event.phase === 'chunk')!;
    assert.ok(bytes > 0 && bytes % 2 === 0);
    assert.ok(returnedMs < first.ms);
    assert.ok(first.ms < times.at(-1)!.ms);
    console.log(
      JSON.stringify({
        returnedMs,
        firstChunkMs: first.ms,
        finishedMs: times.at(-1)!.ms,
        chunks: times.filter((event) => event.phase === 'chunk').length,
        bytes,
      }),
    );
  },
);

test('speech transport waits for reader capacity and drains a completed file without disconnecting', async () => {
  const controller = new AbortController();
  const finished = deferred();
  let written = 0;
  const response = eventStream(
    controller.signal,
    (_send, _close, sendStreaming) => {
      void (async () => {
        for (let i = 0; i < 100; i++) {
          await sendStreaming('speech', { chunk: 'a'.repeat(32768), i });
          written++;
        }
        finished.resolve();
      })();
      return () => {};
    },
    async () => undefined,
  );
  await delay(10);
  assert.ok(written > 0 && written < 100);
  const reader = response.body!.getReader();
  let received = 0;
  const decoder = new TextDecoder();
  while (received < 100) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    if (decoder.decode(value).startsWith('event: speech')) received++;
  }
  await finished.promise;
  assert.equal(written, 100);
  await reader.cancel();
  controller.abort();
});

test('project membership is rechecked for every speech chunk', async (t) => {
  let allowed = true;
  let context!: ChatSessionContext;
  const service = new ThreadService(
    fakeMemory().memory,
    {
      async validate() {},
      async createWorkspace() {
        return '/tmp/project-speech';
      },
      async open(value) {
        context = value;
        return sessionStub();
      },
    },
    {
      async assertMember(userId) {
        if (userId === 'bob' && !allowed)
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: userId === 'alice' ? 'owner' : 'member' };
      },
    },
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    ...settings,
    projectId: 'project123456789',
  });
  await service.run('alice', thread.id, {
    ...settings,
    id: 'input001',
    isImmediate: false,
    parts: [{ type: 'text', text: 'hello' }],
  });
  const events: SpeechEvent[] = [];
  let revoked = false;
  t.after(
    await service.subscribe(
      'bob',
      thread.id,
      () => {},
      () => {
        revoked = true;
      },
      (event) => {
        events.push(event);
      },
    ),
  );
  await context.onEvent({
    type: 'speech',
    event: { phase: 'start', playbackId: 'p', text: 'hello', sequence: 0 },
  });
  allowed = false;
  await context.onEvent({
    type: 'speech',
    event: {
      ...pcm,
      phase: 'chunk',
      playbackId: 'p',
      text: 'hello',
      sequence: 1,
      audio: 'AAA=',
    },
  });
  assert.equal(revoked, true);
  assert.deepEqual(
    events.map((event) => event.phase),
    ['start'],
  );
});
