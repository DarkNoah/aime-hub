import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { Agent } from '@mastra/core/agent';
import { createBackgroundTask } from '@mastra/core/background-tasks';
import { MockMemory } from '@mastra/core/memory';
import { RequestContext } from '@mastra/core/request-context';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { createExecTool } from '../../mastra/tools/exec.js';
import {
  commandDisposition,
  deferredToolContext,
} from '../../mastra/processors/deferred-tool-context.js';
import { commandOutputSchema } from '../../mastra/tools/command/schema.js';
import { createPersonalWorkspace, getWorkspace } from './workspace.js';
import { execCommand } from '../../mastra/tools/exec_command.js';
import { writeStdin } from '../../mastra/tools/write_stdin.js';
import { createTool, isValidationError } from '@mastra/core/tools';
import { readFile } from '../../mastra/tools/read_file.js';
import { z } from 'zod';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import type { LanguageModelService } from '../models/language-model.js';

function toolCallingModel(
  calls: { toolName: string; toolCallId: string; input: object }[],
) {
  let step = 0;
  return new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          const call = calls[step++];
          if (call) {
            controller.enqueue({
              type: 'tool-call',
              ...call,
              input: JSON.stringify(call.input),
            });
          } else {
            controller.enqueue({ type: 'text-start', id: 'reply' });
            controller.enqueue({
              type: 'text-delta',
              id: 'reply',
              delta: 'Done.',
            });
            controller.enqueue({ type: 'text-end', id: 'reply' });
          }
          controller.enqueue({
            type: 'finish',
            finishReason: call ? 'tool-calls' : 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    }),
  });
}

test('a model with toolCall=false can read files and publish a live command that accepts UI cleanup', async (t) => {
  const root = await realpath(await mkdtemp('/tmp/runner-commands-'));
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({ storage, logger: false });
  const model = toolCallingModel([
    {
      toolName: 'read_file',
      toolCallId: 'read-1',
      input: { path: 'probe.txt' },
    },
    {
      toolName: 'exec_command',
      toolCallId: 'command-1',
      input: {
        cmd: 'sleep 60',
        shell: '/bin/sh',
        login: false,
        yield_time_ms: 250,
      },
    },
  ]);
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
  await writeFile(
    `${stored!.metadata!.workspace}/probe.txt`,
    'WORKSPACE_READ_OK',
  );
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

for (const toolName of ['exec_command', 'exec'] as const) {
  test(`queued deferred ${toolName} reconciles results for its original author`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'deferred-tool-'));
    const directory = await createPersonalWorkspace(root, 'alice');
    const marker = randomUUID();
    await writeFile(join(directory, 'probe.txt'), marker);
    const workspace = getWorkspace(
      root,
      'alice',
      directory,
      undefined,
      [],
      undefined,
      {
        getEnv: async (userId) => ({ CALLING_USER: userId ?? 'missing' }),
      },
    );
    const tools = {
      exec_command: execCommand,
      exec: createExecTool({
        getTools: async (context) =>
          context.requestContext?.get('userId') === 'alice' ? [readFile] : [],
      }),
    };
    const args =
      toolName === 'exec_command'
        ? {
            cmd: 'printf ready; touch started; read -r answer; cat probe.txt; printf "/%s/%s" "$CALLING_USER" "$answer"',
            login: false,
            shell: '/bin/sh',
            yield_time_ms: 250,
          }
        : {
            code: "import { browser } from 'browser'; text(await browser.snapshot()); text(await tools.read_file({ path: 'probe.txt' }));",
          };
    const model = toolCallingModel([
      {
        toolName,
        toolCallId: 'execution',
        input: { ...args, _background: { disposition: 'deferred' } },
      },
    ]);
    const storage = new InMemoryStore();
    const requestContext = new RequestContext();
    requestContext.set('userId', 'alice');
    requestContext.set('execBrowser', async () => 'browser-alice');
    const agent = new Agent({
      id: 'deferred-test',
      name: 'Deferred test',
      instructions: 'Execute the requested tool.',
      tools,
      model,
      inputProcessors: [deferredToolContext(requestContext)],
      memory: new MockMemory({ storage, enableMessageHistory: true }),
      workspace,
    });
    const mastra = new Mastra({
      agents: { agent },
      storage,
      logger: false,
      backgroundTasks: { enabled: true, globalConcurrency: 1 },
    });
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = mastra.backgroundTaskManager!;
    const blocker = createBackgroundTask(manager, {
      runId: 'other-run',
      agentId: 'other-agent',
      toolName: 'hold-slot',
      toolCallId: 'hold-slot',
      args: {},
      context: { executor: { execute: () => slot } },
    });
    t.after(async () => {
      release();
      await mastra.shutdown();
      await workspace.destroy();
      await rm(root, { recursive: true, force: true });
    });
    await blocker.dispatch();
    const output = await agent.stream('Run the tool in the background', {
      requestContext,
      memory: { thread: 'test-thread', resource: 'alice' },
      untilIdle: true,
    });
    let startedId: string | undefined;
    let completedId: string | undefined;
    for await (const chunk of output.fullStream) {
      if (chunk.type === 'background-task-completed')
        completedId = chunk.payload.taskId;
      if (chunk.type !== 'background-task-started') continue;
      const task = await manager.getTask(chunk.payload.taskId);
      assert.equal(task?.status, 'pending');
      startedId = chunk.payload.taskId;
      // Another author joins the project thread before the worker acquires a slot.
      requestContext.set('userId', 'bob');
      requestContext.set('execBrowser', async () => 'browser-bob');
      release();
      if (toolName === 'exec_command') {
        try {
          for (let i = 0; i < 300; i++) {
            if (
              await access(join(directory, 'started')).then(
                () => true,
                () => false,
              )
            )
              break;
            await delay(10);
          }
          await access(join(directory, 'started'));
          const reply = await writeStdin.execute!(
            {
              session_id: startedId,
              chars: 'continue\n',
              yield_time_ms: 250,
              max_output_tokens: 1000,
            },
            { workspace, mastra, requestContext },
          );
          assert.ok(reply && !isValidationError(reply));
        } catch (error) {
          await manager.cancel(startedId);
          throw error;
        }
      }
    }
    assert.ok(startedId);
    assert.equal(completedId, startedId);
    const { tasks } = await manager.listTasks({
      toolName,
    });
    assert.equal(tasks.length, 1);
    const [task] = tasks;
    assert.equal(task.status, 'completed', JSON.stringify(task.error));
    assert.equal(task.threadId, 'test-thread');
    assert.equal(task.resourceId, 'alice');
    if (toolName === 'exec_command') {
      const result = commandOutputSchema.parse(task.result);
      assert.equal(result.output, `ready${marker}/alice/continue`);
      assert.equal(result.exit_code, 0);
      assert.equal(result.session_id, undefined);
      assert.deepEqual(workspace.sandbox?.listCommandSessions(), []);
      const completed = await writeStdin.execute!(
        { session_id: task.id, chars: '', max_output_tokens: 100 },
        {
          workspace,
          mastra,
          agent: {
            agentId: agent.id,
            toolCallId: 'finished-read',
            messages: [],
            suspend: async () => {},
            threadId: 'test-thread',
            resourceId: 'alice',
          },
        },
      );
      assert.ok(completed && !isValidationError(completed));
      assert.equal(completed.status, 'completed');
      assert.equal(completed.exit_code, 0);
      assert.equal(completed.output, '');
    } else {
      assert.match(JSON.stringify(task.result), new RegExp(marker));
      assert.match(JSON.stringify(task.result), /browser-alice/);
    }
    assert.ok(
      model.doStreamCalls.some((call) =>
        JSON.stringify(call.prompt).includes(marker),
      ),
    );
  });
}

test('command scheduling options reach the model and the native dispatcher consistently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'command-modes-'));
  const directory = await createPersonalWorkspace(root, 'alice');
  const workspace = getWorkspace(root, 'alice', directory);
  const other = createTool({
    id: 'other',
    description: 'An independent background-capable tool.',
    inputSchema: z.object({}),
    background: { enabled: true, defaultDisposition: 'foreground' },
    execute: async () => 'other',
  });
  const call = (
    name: 'exec_command' | 'exec' | 'other',
    id: string,
    override?: object | null,
  ) => {
    const input =
      name === 'exec_command'
        ? { cmd: 'echo ' + id + '-ok' }
        : name === 'exec'
          ? { code: "text('" + id + "-ok')" }
          : {};
    return {
      toolName: name,
      toolCallId: id,
      input: { ...input, _background: override },
    };
  };
  const model = toolCallingModel([
    call('exec', 'omitted'),
    call('exec_command', 'null', null),
    call('exec_command', 'foreground', { disposition: 'foreground' }),
    call('exec', 'background', { disposition: 'deferred' }),
    call('exec_command', 'awaited', { disposition: 'awaited' }),
    call('exec_command', 'legacy', { enabled: true }),
    call('exec_command', 'overrides', {
      disposition: 'deferred',
      timeoutMs: 7000,
      maxRetries: 3,
    }),
    call('other', 'other', {
      disposition: 'awaited',
      timeoutMs: 8000,
      maxRetries: 2,
    }),
  ]);
  const storage = new InMemoryStore();
  const agent = new Agent({
    memory: new MockMemory({ storage, enableMessageHistory: true }),
    id: 'scheduling',
    name: 'Scheduling',
    instructions: 'Run tools.',
    model,
    workspace,
    tools: {
      exec: createExecTool({ getTools: async () => [] }),
      exec_command: execCommand,
      other,
    },
    inputProcessors: [deferredToolContext()],
    outputProcessors: [commandDisposition],
  });
  const mastra = new Mastra({
    agents: { agent },
    storage,
    logger: false,
    backgroundTasks: { enabled: true },
  });
  t.after(async () => {
    await mastra.shutdown();
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const output = await agent.stream('Run the commands', {
    maxSteps: 16,
    untilIdle: true,
    memory: { thread: 'test', resource: 'alice' },
  });
  const results = new Map<string, unknown>();
  for await (const chunk of output.fullStream)
    if (chunk.type === 'tool-result')
      results.set(chunk.payload.toolCallId, chunk.payload.result);
    else if (chunk.type === 'error')
      assert.fail(JSON.stringify(chunk.payload.error));
  const request = model.doStreamCalls[0];
  for (const name of ['exec', 'exec_command', 'other']) {
    const definition = request.tools?.find((tool) => tool.name === name);
    assert.ok(definition && definition.type === 'function');
    const background = JSON.stringify(
      definition.inputSchema.properties?._background,
    );
    assert.ok(background, name);
    if (name === 'other') assert.match(background, /awaited/);
    else {
      assert.match(background, /deferred/);
      assert.match(background, /null/);
      assert.doesNotMatch(background, /awaited|timeoutMs|maxRetries/);
    }
  }
  const prompt = JSON.stringify(request.prompt);
  assert.match(prompt, /- other .default: foreground/);
  assert.doesNotMatch(prompt, /- exec(?:_command)? .default:/);
  for (const id of ['foreground', 'omitted', 'null', 'awaited'])
    assert.match(
      String(JSON.stringify(results.get(id))),
      new RegExp(id + '-ok'),
      id,
    );
  const { tasks } = await mastra.backgroundTaskManager!.listTasks({});
  assert.deepEqual(
    tasks
      .map((task) => [task.toolCallId, task.timeoutMs, task.maxRetries])
      .sort(),
    [
      ['background', 0, 0],
      ['legacy', 0, 0],
      ['other', 8000, 2],
      ['overrides', 0, 0],
    ],
  );
  for (const task of tasks) {
    assert.equal(task.status, 'completed');
    assert.match(JSON.stringify(task.result), new RegExp(task.toolCallId));
  }
});
