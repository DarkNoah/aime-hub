import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { XinferenceProvider } from '../../mastra/providers/xinference.js';
import { wavMetadata } from '../../mastra/providers/audio-data.js';
import { createSpeechTool } from '../../mastra/tools/speech.js';
import { ToolService } from './service.js';
import { readFileBlocks } from '../../../../web/src/components/chat/message-preview/read-file-output.js';
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
    assert.ok(result && 'content' in result);
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
    if (reference)
      await w.workspace.filesystem!.writeFile(
        'reference.wav',
        await readFile(reference),
      );
    const recorded: unknown[] = [];
    const tool = createSpeechTool(defaultSpeechConfig, {
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
        text:
          process.env.XINFERENCE_SPEECH_TEXT ??
          '你好，这是语音工具的真实测试。',
        instruct: process.env.XINFERENCE_SPEECH_INSTRUCT,
        ...(reference
          ? {
              ref_audio: 'reference.wav',
              ref_text: process.env.XINFERENCE_PROMPT_TEXT,
            }
          : {}),
      },
      { ...w, agent: scope },
    );
    assert.equal(output.ok, true, JSON.stringify(output));
    await tool.onOutput!({
      output,
      toolName: 'speech',
      toolCallId: 'live-speech-call',
    });
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

test('speech generates WAV, saves a workspace asset and returns playable media without base64 in model history', async (t) => {
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
      text: 'Hello',
      instruct: 'Happy and bright',
      save_path: 'outputs/audio/hello world.wav',
    },
    { ...w, agent: scope },
  );
  assert.equal(output.ok, true);
  assert.deepEqual(await readFile(join(w.directory, output.file_path!)), wav);
  assert.equal(output.duration, 1);
  assert.equal(output.sampleRate, 8000);
  const payload = JSON.parse(String(f.calls[0][1].body));
  assert.equal(payload.response_format, 'wav');
  assert.deepEqual(JSON.parse(payload.kwargs), {
    control_instruction: 'Happy and bright',
  });
  assert.equal(f.calls[0][0], 'https://speech.example/v1/audio/speech');
  assert.equal(f.calls[0][1].headers?.authorization, 'Bearer synthetic-secret');
  const blocks = readFileBlocks(output);
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
  const attachments = getToolAttachments([
    {
      type: 'dynamic-tool',
      toolName: 'speech',
      toolCallId: 'call',
      state: 'output-available',
      input: { text: 'Hello' },
      output,
    },
  ]);
  assert.equal(attachments[0]?.mediaType, 'audio/wav');
  const modelOutput = tool.toModelOutput!(output);
  assert.ok(
    modelOutput && typeof modelOutput === 'object' && 'type' in modelOutput,
  );
  assert.equal(modelOutput.type, 'text');
  assert.doesNotMatch(
    JSON.stringify(tool.toModelOutput!(output)),
    /synthetic-secret|base64|\/api\/threads/,
  );
  await tool.onOutput!({ output, toolName: 'speech', toolCallId: 'call' });
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
  await tool.onOutput!({
    output: { ok: false, isError: true, content: [] },
    toolName: 'speech',
    toolCallId: 'ignored',
  });
  assert.equal(recorded.length, 1);
});

test('workspace and public reference audio become multipart with accurate transcript and no download credentials', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  await w.workspace.filesystem!.writeFile('reference.wav', wav);
  const downloads: Parameters<Request>[] = [];
  const tool = createSpeechTool(defaultSpeechConfig, {
    resolveModel: f.resolveModel,
    request: async (url, options) => {
      downloads.push([url, options]);
      return { url, status: 200, headers: {}, body: wav };
    },
  });
  for (const ref_audio of [
    'reference.wav',
    'https://cdn.example/reference.wav',
  ]) {
    const output = await runnable(tool)(
      { text: 'New text', ref_audio, ref_text: 'Reference transcript' },
      w,
    );
    assert.equal(output.ok, true);
    const options = f.calls.at(-1)![1];
    const form = await new Response(
      new Uint8Array(Buffer.from(options.body!)),
      { headers: { 'content-type': options.headers!['content-type'] } },
    ).formData();
    assert.equal(form.get('response_format'), 'wav');
    assert.deepEqual(JSON.parse(String(form.get('kwargs'))), {
      prompt_text: 'Reference transcript',
    });
    const file = form.get('prompt_speech') as File;
    assert.equal(file.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
  }
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0][1].headers, undefined);
});

test('invalid reference pairs, workspace paths, existing outputs and non-audio references fail before generation', async (t) => {
  const f = fixture();
  const w = await workspace(t);
  await w.workspace.filesystem!.writeFile('existing.wav', wav);
  await w.workspace.filesystem!.writeFile('not-audio.txt', 'not audio');
  const execute = runnable(
    createSpeechTool(defaultSpeechConfig, { resolveModel: f.resolveModel }),
  );
  for (const patch of [
    { ref_audio: 'reference.wav' },
    { ref_text: 'orphan transcript' },
    { save_path: '/tmp/out.wav' },
    { save_path: '../out.wav' },
    { save_path: 'out.mp3' },
    { save_path: 'existing.wav' },
    { ref_audio: '/etc/passwd', ref_text: 'text' },
    { ref_audio: '../outside.wav', ref_text: 'text' },
    { ref_audio: 'not-audio.txt', ref_text: 'text' },
  ])
    assert.equal((await execute({ text: 'Hello', ...patch }, w)).isError, true);
  assert.equal((await execute({ text: 'Hello' })).isError, true);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readFile(join(w.directory, 'existing.wav')), wav);
});

test('malformed audio, cancellation, timeouts and upstream errors never save successful output or expose secrets', async (t) => {
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
    const result = await runnable(
      createSpeechTool(defaultSpeechConfig, { resolveModel: f.resolveModel }),
    )({ text: 'Hello' }, w);
    assert.equal(result.isError, true);
    assert.equal(result.file_path, undefined);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  }
  const f = fixture(async () => {
    throw new Error('Bearer synthetic-secret');
  });
  const execute = runnable(
    createSpeechTool(defaultSpeechConfig, { resolveModel: f.resolveModel }),
  );
  assert.match(
    JSON.stringify(
      await execute(
        { text: 'Hello' },
        { ...w, abortSignal: AbortSignal.abort() },
      ),
    ),
    /cancelled/,
  );
  assert.equal(f.calls.length, 0);
  const failed = await execute({ text: 'Hello' }, w);
  assert.equal(failed.isError, true);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-secret/);
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
  const timeout = await runnable(
    createSpeechTool(
      { ...defaultSpeechConfig, timeoutMs: 1000 },
      { resolveModel: slow.resolveModel },
    ),
  )({ text: 'Hello' }, w);
  assert.match(JSON.stringify(timeout), /timed out/);
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
  const providers: ConstructorParameters<typeof ToolService>[1] = {
    getProvider: async () => {
      throw new Error('Unused');
    },
    getDefaults: async () => ({
      ...emptyModelDefaults,
      speechModel: state.selected || null,
    }),
    getModel: async () =>
      ({
        enabled: state.enabled,
        modelType: state.modelType,
        name: 'VoxCPM2',
        modalitiesOutput: ['audio'],
      }) as Awaited<ReturnType<typeof providers.getModel>>,
    getProviderInstance: async () => {
      if (!state.providerEnabled) throw new Error('Disabled provider');
      return f.provider;
    },
  };
  const service = new ToolService(database, providers);
  assert.deepEqual((await service.get('speech')).config, defaultSpeechConfig);
  const built = (await service.buildTools(['speech'])).speech;
  assert.ok('execute' in built && built.execute);
  assert.equal(
    (await built.execute({ text: 'Hello', instruct: 'Happy' }, w)).model,
    'voices/alias',
  );
  assert.deepEqual(JSON.parse(JSON.parse(String(f.calls[0][1].body)).kwargs), {
    control_instruction: 'Happy',
  });
  state.selected = 'voices/changed';
  assert.equal(
    (await built.execute({ text: 'Hello' }, w)).model,
    state.selected,
  );
  await service.update('speech', {
    ...defaultSpeechConfig,
    model: 'voices/fixed',
  });
  const explicit = (await service.buildTools(['speech'])).speech;
  assert.ok('execute' in explicit && explicit.execute);
  assert.equal(
    (await explicit.execute({ text: 'Hello' }, w)).model,
    'voices/fixed',
  );
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
    assert.equal((await built.execute({ text: 'Hello' }, w)).isError, true);
  }
  Object.assign(state, {
    enabled: true,
    modelType: 'speech',
    providerEnabled: true,
    selected: '',
  });
  assert.match(
    JSON.stringify(await built.execute({ text: 'Hello' }, w)),
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
              input: JSON.stringify({ text: 'Hello' }),
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
