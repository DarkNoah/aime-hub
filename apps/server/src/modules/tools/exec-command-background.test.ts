import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isValidationError } from '@mastra/core/tools';
import { CommandSandbox } from '../../mastra/tools/command/sandbox.js';
import { commandInputSchema } from '../../mastra/tools/command/schema.js';
import { execCommand } from '../../mastra/tools/exec_command.js';
import { createPersonalWorkspace, getWorkspace } from '../threads/workspace.js';

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
  return {
    directory,
    sandbox,
    run: (cmd: string, abortSignal?: AbortSignal) =>
      execCommand.execute!(
        commandInputSchema.parse({
          cmd,
          shell: '/bin/sh',
          login: false,
          yield_time_ms: 250,
          max_output_tokens: 3,
        }),
        { workspace, agent, abortSignal },
      ),
  };
}

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
  let pid: number | undefined;
  for (let i = 0; i < 200 && !pid; i++) {
    pid = Number(
      await readFile(join(f.directory, 'pid'), 'utf8').catch(() => ''),
    );
    if (!pid) await delay(10);
  }
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
