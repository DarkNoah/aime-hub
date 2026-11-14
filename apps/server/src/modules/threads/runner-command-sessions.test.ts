import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { execCommand } from '../../mastra/tools/exec_command.js';
import { readFile } from '../../mastra/tools/read_file.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import type { LanguageModelService } from '../models/language-model.js';

test('a model with toolCall=false can read files and publish a live command that accepts UI cleanup', async (t) => {
  const root = await realpath(await mkdtemp('/tmp/runner-commands-'));
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({ storage, logger: false });
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => {
      const step = calls++;
      const initial = step < 2;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (step === 0)
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'read-1',
                toolName: 'read_file',
                input: JSON.stringify({ path: 'probe.txt' }),
              });
            else if (initial)
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'command-1',
                toolName: 'exec_command',
                input: JSON.stringify({
                  cmd: 'sleep 60',
                  shell: '/bin/sh',
                  login: false,
                  yield_time_ms: 250,
                }),
              });
            else {
              controller.enqueue({ type: 'text-start', id: 'reply' });
              controller.enqueue({
                type: 'text-delta',
                id: 'reply',
                delta: 'Process started.',
              });
              controller.enqueue({ type: 'text-end', id: 'reply' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: initial ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  });
  const runner = createChatRunner(
    mastra,
    {
      getLanguageModel: async () => ({
        model,
        reference: 'mock',
        providerOptions: {},
        supportsImages: false,
        toolCall: false,
      }),
    } as unknown as LanguageModelService,
    root,
    undefined,
    {
      buildTools: async () => ({
        read_file: readFile,
        exec_command: execCommand,
      }),
    },
  );
  const service = new ThreadService(memory, runner);
  t.after(async () => {
    await service.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const thread = await service.createThread('alice', settings);
  await service.updateThread('alice', thread.id, {
    title: 'Command lifecycle',
  });
  const stored = await memory.getThreadById({ threadId: thread.id });
  await writeFile(`${stored!.metadata!.workspace}/probe.txt`, 'WORKSPACE_READ_OK');
  let announced = false;
  const unsubscribe = await service.subscribe(
    'alice',
    thread.id,
    (snapshot) => {
      if (snapshot.commandSessions?.length) announced = true;
    },
  );
  await service.run('alice', thread.id, {
    ...settings,
    id: 'command01',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Launch command' }],
  });
  let snapshot = await service.getThread('alice', thread.id);
  for (let i = 0; i < 300 && snapshot.thread.status !== 'success'; i++) {
    await delay(10);
    snapshot = await service.getThread('alice', thread.id);
  }
  assert.equal(
    snapshot.thread.status,
    'success',
    JSON.stringify(snapshot.thread),
  );
  const read = snapshot.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool-read_file');
  assert.ok(read && 'output' in read);
  assert.equal(typeof read.output, 'string');
  assert.match(String(read.output), /WORKSPACE_READ_OK/);
  assert.equal(
    snapshot.commandSessions?.length,
    1,
    JSON.stringify(snapshot.messages),
  );
  assert.equal(snapshot.commandSessions![0].status, 'running');
  assert.equal(announced, true);
  assert.deepEqual(snapshot.backgroundTasks, []);
  const command = snapshot.commandSessions![0];
  unsubscribe();
  await service.cleanupCommandSession('alice', thread.id, command.sessionId);
  assert.deepEqual(
    (await service.getThread('alice', thread.id)).commandSessions,
    [],
  );
  assert.throws(() => process.kill(Number(command.pid), 0), { code: 'ESRCH' });
});
