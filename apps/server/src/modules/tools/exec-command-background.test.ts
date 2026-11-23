import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import {
  createBackgroundTask,
  resolveBackgroundConfig,
} from '@mastra/core/background-tasks';
import { isValidationError } from '@mastra/core/tools';
import { CommandSandbox } from '../../mastra/tools/command/sandbox.js';
import { commandInputSchema } from '../../mastra/tools/command/schema.js';
import { execCommand } from '../../mastra/tools/exec_command.js';
import { writeStdin } from '../../mastra/tools/write_stdin.js';
import { createPersonalWorkspace, getWorkspace } from '../threads/workspace.js';

async function readMarker(directory: string, name: string) {
  for (let i = 0; i < 200; i++) {
    const marker = await readFile(join(directory, name), 'utf8').catch(
      () => undefined,
    );
    if (marker !== undefined && marker.trim()) return marker.trim();
    await delay(10);
  }
  assert.fail(`Command never wrote ${name}`);
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bg-command-')));
  const directory = await createPersonalWorkspace(root, 'alice');
  const workspace = getWorkspace(root, 'alice', directory);
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const sandbox = workspace.sandbox;
  assert.ok(sandbox instanceof CommandSandbox);
  const agent = {
    agentId: 'test',
    toolCallId: 'command',
    messages: [],
    suspend: async () => {},
    isBackgroundTask: true,
  };
  const taskId = randomUUID();
  const background = {
    taskId,
    disposition: 'deferred' as const,
    adopt: () => assert.fail('Mastra owns the task'),
  };
  return {
    directory,
    workspace,
    taskId,
    async write(sessionId: string, chars = '', terminate = false) {
      const output = await writeStdin.execute!(
        {
          session_id: sessionId,
          chars,
          terminate,
          yield_time_ms: 250,
          max_output_tokens: 1000,
        },
        { workspace },
      );
      assert.ok(output && !isValidationError(output));
      return output;
    },
    sandbox,
    run: (
      cmd: string,
      abortSignal?: AbortSignal,
      options: { tty?: boolean; max_output_tokens?: number } = {},
    ) =>
      execCommand.execute!(
        commandInputSchema.parse({
          cmd,
          shell: '/bin/sh',
          login: false,
          yield_time_ms: 250,
          max_output_tokens: 3,
          ...options,
        }),
        { workspace, agent, background, abortSignal },
      ),
  };
}

test('foreground commands without a yield interval wait past the old 10-second default', async (t) => {
  const f = await fixture(t);
  assert.equal(
    resolveBackgroundConfig({
      toolName: execCommand.id,
      toolConfig: execCommand.background,
      llmBgOverrides: {},
    }).disposition,
    'foreground',
  );
  await f.workspace.init();
  const command = commandInputSchema.parse({
    cmd: 'while [ ! -f finish ]; do sleep 0.02; done; printf finished; exit 9',
    login: false,
  });
  assert.equal(command.yield_time_ms, undefined);
  let running!: () => void;
  const started = new Promise<void>((resolve) => {
    running = resolve;
  });
  const unsubscribe = f.sandbox.onCommandSessionsChanged(() => {
    if (f.sandbox.listCommandSessions().some((s) => s.status === 'running'))
      running();
  });
  t.after(unsubscribe);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const done = execCommand.execute!(command, { workspace: f.workspace });
  await started;
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  await writeFile(join(f.directory, 'finish'), '');
  const result = await done;
  assert.ok(result && !isValidationError(result));
  assert.equal(result.output, 'finished');
  assert.equal(result.exit_code, 9);
  assert.equal(result.session_id, undefined);
});

test('a native background command returns bounded output and final exit code across the foreground yield interval', async (t) => {
  const f = await fixture(t);
  const result = await f.run(
    'printf before; sleep 0.4; printf after123; exit 7',
  );
  assert.ok(result && !isValidationError(result));
  assert.equal(result.output, 'beforeafter1');
  assert.equal(result.truncated, true);
  assert.equal(result.original_token_count, 4);
  assert.equal(result.exit_code, 7);
  assert.equal(result.session_id, undefined);
});

test('the native task owns its command and cancelling it kills the process', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const result = f.run('echo $$ > pid; exec sleep 30', controller.signal);
  const cancelled = assert.rejects(result, /cancel background command/);
  const pid = Number(await readMarker(f.directory, 'pid'));
  assert.ok(pid, 'background process started');
  assert.deepEqual(f.sandbox.listCommandSessions(), []);
  controller.abort(new Error('cancel background command'));
  await cancelled;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('foreground cancellation reports an interrupted command to the caller', async () => {
  const result = await execCommand.execute!(
    commandInputSchema.parse({ cmd: 'pwd' }),
    { abortSignal: AbortSignal.abort() },
  );
  assert.ok(result && !isValidationError(result));
  assert.equal(result.output, '用户中止了操作');
  assert.equal(result.exit_code, 130);
  assert.equal(result.session_id, undefined);
});

test('aborting a numeric-session wait stops its process and releases the session', async (t) => {
  const f = await fixture(t);
  const started = await execCommand.execute!(
    commandInputSchema.parse({
      cmd: 'exec sleep 30',
      yield_time_ms: 250,
      login: false,
    }),
    { workspace: f.workspace },
  );
  assert.ok(
    started &&
      !isValidationError(started) &&
      typeof started.session_id === 'number',
  );
  const pid = Number(f.sandbox.listCommandSessions()[0].pid);
  const cancel = new AbortController();
  const waiting = writeStdin.execute!(
    {
      session_id: started.session_id,
      chars: '',
      yield_time_ms: 30_000,
      max_output_tokens: 100,
    },
    { workspace: f.workspace, abortSignal: cancel.signal },
  );
  await delay(10);
  cancel.abort();
  const stopped = await waiting;
  assert.ok(stopped && !isValidationError(stopped));
  assert.equal(stopped.output, '用户中止了操作');
  assert.equal(stopped.exit_code, 130);
  assert.deepEqual(f.sandbox.listCommandSessions(), []);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

for (const tty of [false, true]) {
  test(`deferred ${tty ? 'PTY' : 'pipe'} commands support task-id input and incremental output without consuming the final transcript`, async (t) => {
    const f = await fixture(t);
    const other = await fixture(t);
    const controller = new AbortController();
    const running = f.run(
      'printf "ready\\n"; echo 1 > ready; read -r name; printf "received=%s\\n" "$name"; read -r end; printf "final=%s\\n" "$end"; exit 7',
      controller.signal,
      { tty, max_output_tokens: 1000 },
    );
    try {
      await readMarker(f.directory, 'ready');
      const initial = await f.write(f.taskId);
      assert.equal(initial.session_id, f.taskId);
      assert.match(initial.output, /ready/);
      await assert.rejects(other.write(f.taskId, 'another workspace\n'));
      assert.equal((await f.write(f.taskId)).output, '');
      let partial = (await f.write(f.taskId, '应用🙂\n')).output;
      for (let i = 0; i < 20 && !partial.includes('received=应用🙂'); i++) {
        partial += (await f.write(f.taskId)).output;
      }
      assert.match(partial, /received=应用🙂/);
      assert.doesNotMatch(partial, /ready/);
      await f.write(f.taskId, 'done\n');
      const final = await running;
      assert.ok(final && !isValidationError(final));
      assert.equal(final.exit_code, 7);
      assert.match(
        final.output,
        /ready[\s\S]*received=应用🙂[\s\S]*final=done/,
      );
      assert.equal(final.session_id, undefined);
    } finally {
      controller.abort();
      await running.catch(() => {});
    }
  });

  test(`write_stdin terminates a deferred ${tty ? 'PTY' : 'pipe'} process and its child`, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const running = f.run(
      'sleep 60 & child=$!; echo "$child" > child; wait',
      controller.signal,
      { tty },
    );
    try {
      const child = Number(await readMarker(f.directory, 'child'));
      assert.ok(child);
      const reader = f.write(f.taskId);
      const stopped = await f.write(f.taskId, '', true);
      const observed = await reader;
      assert.notEqual(stopped.exit_code, undefined);
      assert.equal(observed.exit_code, stopped.exit_code);
      const result = await running;
      assert.ok(result && !isValidationError(result));
      assert.notEqual(result.exit_code, undefined);
      assert.notEqual(result.exit_code, 0);
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(child, 0);
        } catch {
          break;
        }
        await delay(25);
      }
      assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
    } finally {
      controller.abort();
      await running.catch(() => {});
    }
  });
}

test('write_stdin reads and cancels only queued shell tasks in this thread and resource', async (t) => {
  const f = await fixture(t);
  const mastra = new Mastra({
    storage: new InMemoryStore(),
    logger: false,
    backgroundTasks: { enabled: true, globalConcurrency: 1 },
  });
  const manager = mastra.backgroundTaskManager!;
  const agent = {
    agentId: 'agent',
    toolCallId: 'write',
    threadId: 'thread',
    resourceId: 'alice',
    messages: [],
    suspend: async () => {},
  };
  const write = async (
    id: string,
    options: { chars?: string; terminate?: boolean } = {},
    scope = agent,
  ) => {
    const result = await writeStdin.execute!(
      { session_id: id, chars: '', max_output_tokens: 100, ...options },
      { workspace: f.workspace, mastra, agent: scope },
    );
    assert.ok(result && !isValidationError(result));
    return result;
  };
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await mastra.shutdown();
  });
  const payload = {
    runId: 'run',
    agentId: 'agent',
    threadId: agent.threadId,
    resourceId: agent.resourceId,
    args: {},
  };
  const blocker = await createBackgroundTask(manager, {
    ...payload,
    toolName: 'another_tool',
    toolCallId: 'blocker',
    context: { executor: { execute: () => slot } },
  }).dispatch();
  let executions = 0;
  const { task } = await createBackgroundTask(manager, {
    ...payload,
    toolName: 'exec_command',
    toolCallId: 'queued',
    context: {
      executor: {
        execute: async () => {
          executions++;
          return 'unexpected execution';
        },
      },
    },
  }).dispatch();

  const pending = await write(task.id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.session_id, task.id);
  await assert.rejects(
    write(task.id, { chars: 'too early\n' }),
    /input was not sent/,
  );
  for (const scope of [
    { ...agent, threadId: 'other' },
    { ...agent, resourceId: 'bob' },
  ]) {
    await assert.rejects(write(task.id, {}, scope), /Unknown command session/);
    await assert.rejects(
      write(task.id, { terminate: true }, scope),
      /Unknown command session/,
    );
  }
  await assert.rejects(
    write(blocker.task.id, { terminate: true }),
    /Unknown command session/,
  );
  assert.equal((await manager.getTask(task.id))?.status, 'pending');
  const cancelled = await write(task.id, { terminate: true });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.session_id, undefined);
  release();
  assert.equal((await manager.getTask(task.id))?.status, 'cancelled');
  assert.equal(executions, 0);
});
