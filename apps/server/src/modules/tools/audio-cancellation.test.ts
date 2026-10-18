import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import { isToolUIPart, type UIMessage } from 'ai';
import {
  defaultSpeechConfig,
  defaultTranscriptionsConfig,
} from '@aime/shared/tools';
import { transcriptionFormats } from '@aime/shared/audio';
import { OpenAICompatibleProvider } from '../../mastra/providers/openai-compatible.js';
import { createSpeechTool } from '../../mastra/tools/speech.js';
import { createTranscriptionsTool } from '../../mastra/tools/transcriptions.js';
import { AudioService } from '../audio/service.js';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from '../threads/runner.js';
import { ThreadService } from '../threads/service.js';
import { parseTranscriptionsOutput } from '../../../../web/src/components/chat/message-preview/transcriptions-output.js';
import { parseSpeechOutput } from '../../../../web/src/components/chat/message-preview/speech-output.js';

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

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for audio cancellation');
}

async function fixture(t: test.TestContext, lateSuccess = false) {
  const root = await realpath(await mkdtemp('/tmp/audio-cancellation-'));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: join(root, 'workspace') }),
  });
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  let providerSignal: AbortSignal | undefined;
  const provider = new OpenAICompatibleProvider(
    { id: 'audio', type: 'openai', baseUrl: 'https://audio.example.test/v1' },
    undefined,
    async (url, options) => {
      providerSignal = options.signal;
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
      // Some providers return a response despite cancellation; never save it.
      if (!lateSuccess) throw options.signal.reason;
      const speech = url.endsWith('/speech');
      return {
        url,
        status: 200,
        headers: { 'content-type': speech ? 'audio/wav' : 'application/json' },
        body: speech ? wav : Buffer.from('{"text":"late transcript"}'),
      };
    },
  );
  const audio = new AudioService(
    root,
    {
      getSpeechModel: async () => provider.speechModel('speech'),
      getTranscriptionModel: async () => provider.transcriptionModel('asr'),
    },
    async () => defaultTranscriptionsConfig,
  );
  const voice = await audio.voices.create(
    'alice',
    {
      name: 'sample',
      text: 'Hello',
      description: '',
      shared: false,
    },
    wav,
  );
  const tools = {
    speech: createSpeechTool(defaultSpeechConfig, {
      resolveModel: async () => ({
        reference: 'audio/speech',
        model: provider.speechModel('speech'),
      }),
      recordAsset: async () => {
        assert.fail('Cancelled speech must not record an asset');
      },
    }),
    transcriptions: createTranscriptionsTool(
      defaultTranscriptionsConfig,
      audio,
    ),
  };
  const inputs = {
    speech: { input: 'Hello', voice: 'alloy', save_path: 'cancelled.wav' },
    transcriptions: {
      file: voice.audioPath,
      response_format: 'json' as const,
      save_path: 'cancelled.json',
    },
  };
  const requestContext = new RequestContext();
  requestContext.set('userId', 'alice');
  const context = {
    workspace,
    requestContext,
    observe: {
      span: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      log: () => {},
    },
  };
  return {
    root,
    workspace,
    tools,
    inputs,
    context,
    signal: () => providerSignal,
  };
}

for (const name of ['speech', 'transcriptions'] as const) {
  const message =
    name === 'speech'
      ? 'Speech generation was cancelled.'
      : 'Speech recognition was cancelled.';
  for (const mode of ['before', 'during', 'late'] as const) {
    test(
      `${name} returns cancellation text ${mode} provider execution without saving output`,
      { timeout: 10000 },
      async (t) => {
        const f = await fixture(t, mode === 'late');
        const controller = new AbortController();
        const context = { ...f.context, abortSignal: controller.signal };
        if (mode === 'before') controller.abort();
        const running =
          name === 'speech'
            ? f.tools.speech.execute!(f.inputs.speech, context)
            : f.tools.transcriptions.execute!(f.inputs.transcriptions, context);
        if (mode !== 'before') {
          await waitFor(() => !!f.signal());
          controller.abort();
        }
        const output = await running;
        assert.equal(output, message);
        assert.deepEqual(
          await f.tools[name].outputSchema!['~standard'].validate(output),
          { value: message },
        );
        assert.deepEqual(
          name === 'speech'
            ? f.tools.speech.toModelOutput!('Speech generation was cancelled.')
            : f.tools.transcriptions.toModelOutput!(message),
          { type: 'text', value: message },
        );
        assert.equal(
          await f.workspace.filesystem!.exists(f.inputs[name].save_path),
          false,
        );
        assert.equal(f.signal()?.aborted, mode === 'before' ? undefined : true);
        if (name === 'transcriptions') {
          for (const format of transcriptionFormats)
            assert.equal(parseTranscriptionsOutput(output, format), null);
        } else {
          assert.equal(parseSpeechOutput(output), null);
          assert.equal(
            await f.tools.speech.execute!(
              { input: 'Hello', voice: 'alloy', play_immediately: true },
              context,
            ),
            message,
          );
        }
      },
    );
  }

  test(
    `${name} cancellation text is persisted and published when stopping a native chat`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const storage = new InMemoryStore();
      const mastra = new Mastra({ storage, logger: false });
      let calls = 0;
      const model = new MastraLanguageModelV2Mock({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              if (++calls === 1)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'cancel-audio',
                  toolName: name,
                  input: JSON.stringify(f.inputs[name]),
                });
              controller.enqueue({
                type: 'finish',
                finishReason: calls === 1 ? 'tool-calls' : 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          }),
        }),
      });
      const runner = createChatRunner(
        mastra,
        {
          getLanguageModel: async () => ({
            model,
            reference: 'mock',
            providerOptions: {},
            supportsImages: false,
            toolCall: true,
          }),
        } as unknown as LanguageModelService,
        f.root,
        undefined,
        { buildTools: async () => f.tools },
      );
      const service = new ThreadService(
        new Memory({ storage, options: { generateTitle: false } }),
        runner,
      );
      t.after(async () => {
        await service.shutdown();
        await mastra.shutdown();
      });
      const settings = { model: null, reasoningEffort: 'auto' } as const;
      const thread = await service.createThread('alice', settings);
      const received = new Map<string, UIMessage>();
      await service.subscribe('alice', thread.id, (snapshot) => {
        for (const message of snapshot.messages)
          received.set(message.id, message);
      });
      await service.run('alice', thread.id, {
        ...settings,
        id: 'audio-message',
        parts: [{ type: 'text', text: 'Run audio' }],
        isImmediate: false,
      });
      await waitFor(() => !!f.signal());
      await service.abort('alice', thread.id);
      const part = (messages: UIMessage[]) =>
        messages
          .flatMap((message) => message.parts)
          .filter(isToolUIPart)
          .find((part) => part.toolCallId === 'cancel-audio');
      await waitFor(
        async () =>
          part((await service.history('alice', thread.id)).messages)?.output ===
          message,
      );
      await waitFor(() => part([...received.values()])?.output === message);
      const snapshot = await service.getThread('alice', thread.id);
      assert.equal(snapshot.thread.status, 'canceled');
      assert.equal(part(snapshot.messages)?.state, 'output-available');
      assert.equal(part(snapshot.messages)?.output, message);
      assert.equal(calls, 1);
    },
  );
}
