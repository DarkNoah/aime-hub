import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { LocalApiAccess } from '../auth/local-api.js';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryStore } from '@mastra/core/storage';
import { Mastra } from '@mastra/core/mastra';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import type { LanguageModelService } from '../models/language-model.js';
import { noopObserve, isValidationError } from '@mastra/core/tools';
import { execCommand } from '../../mastra/tools/exec_command.js';
import { commandInputSchema } from '../../mastra/tools/command/schema.js';
import {
  createPersonalWorkspace,
  createProjectWorkspace,
  getWorkspace,
} from './workspace.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const inspectEnv = `${quote(process.execPath)} -e ${quote(
  'console.log(JSON.stringify({ value: process.env.COMMAND_ENV_TEST ?? null, empty: process.env.COMMAND_ENV_EMPTY ?? null, skillHome: process.env.SKILL_HOME, skillsRoot: process.env.SKILLS_ROOT, appApiScript: process.env.APP_API_SCRIPT, path: Boolean(process.env.PATH) }))',
)}`;

for (const projectId of [undefined, 'project000000001']) {
  test(`exec_command refreshes configured env in ${projectId ? 'project' : 'personal'} workspaces`, async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'workspace-env-')),
    );
    const directory = projectId
      ? await createProjectWorkspace(root, projectId)
      : await createPersonalWorkspace(root, 'alice');
    const skillHome = join(
      root,
      projectId ? 'projects' : 'users',
      projectId ?? 'alice',
      '.agents',
      'skills',
    );
    const skillsRoot = join(root, '.agents', 'skills');
    const appApiScript = join(
      skillsRoot,
      'builtin',
      'docs',
      'scripts',
      'app-api.mjs',
    );
    let env: Record<string, string> = {
      COMMAND_ENV_TEST: '  first line\n"$`\\测试  ',
      COMMAND_ENV_EMPTY: '',
      SKILL_HOME: '/should-not-replace-session-scope',
      SKILLS_ROOT: '/should-not-replace-global-root',
      APP_API_SCRIPT: '/should-not-replace-builtin-script',
    };
    let unavailable = false;
    const workspace = getWorkspace(
      root,
      'alice',
      directory,
      projectId,
      [],
      undefined,
      {
        async getEnv() {
          if (unavailable)
            throw new Error('Environment configuration unavailable');
          return { ...env };
        },
      },
    );
    t.after(async () => {
      await workspace.destroy();
      await rm(root, { recursive: true, force: true });
    });
    await workspace.init();
    const run = async (cmd = inspectEnv, tty = false) => {
      const result = await execCommand.execute!(
        commandInputSchema.parse({ cmd, tty, login: false }),
        { workspace, observe: noopObserve },
      );
      assert.ok(result && !isValidationError(result));
      assert.equal(result.exit_code, 0);
      return result.output;
    };
    assert.deepEqual(JSON.parse(await run()), {
      value: env.COMMAND_ENV_TEST,
      empty: '',
      skillHome,
      skillsRoot,
      appApiScript,
      path: true,
    });
    assert.equal(process.env.COMMAND_ENV_TEST, undefined);

    env = { COMMAND_ENV_TEST: 'updated' };
    assert.deepEqual(JSON.parse(await run()), {
      value: 'updated',
      empty: null,
      skillHome,
      skillsRoot,
      appApiScript,
      path: true,
    });

    env = { COMMAND_ENV_TEST: 'pty' };
    const ptyEnv = JSON.parse(await run(inspectEnv, true));
    assert.equal(ptyEnv.value, 'pty');
    assert.equal(ptyEnv.skillsRoot, skillsRoot);
    assert.equal(ptyEnv.appApiScript, appApiScript);

    env = {};
    assert.deepEqual(JSON.parse(await run()), {
      value: null,
      empty: null,
      skillHome,
      skillsRoot,
      appApiScript,
      path: true,
    });

    unavailable = true;
    await assert.rejects(
      () => run('touch must-not-run'),
      /Environment configuration unavailable/,
    );
    await assert.rejects(readFile(join(directory, 'must-not-run')), {
      code: 'ENOENT',
    });
  });
}

test('commands isolate credentials by current author, including concurrent pipe and PTY calls', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'workspace-api-env-')),
  );
  const projectId = 'project000000001';
  const directory = await createProjectWorkspace(root, projectId);
  const localApi = new LocalApiAccess(
    'http://127.0.0.1:3000/api',
    async () => true,
  );
  const workspace = getWorkspace(
    root,
    'creator',
    directory,
    projectId,
    [],
    undefined,
    { getEnv: async () => ({ APP_API_TOKEN: 'must-not-use-global-token' }) },
    (author) => localApi.environment(author),
  );
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  await workspace.init();
  const run = async (author?: string, tty = false) => {
    const requestContext = new RequestContext();
    if (author) requestContext.set('userId', author);
    const result = await execCommand.execute!(
      commandInputSchema.parse({
        cmd: `${quote(process.execPath)} -e ${quote('console.log(JSON.stringify({token:process.env.APP_API_TOKEN,url:process.env.APP_API_URL}))')}`,
        tty,
        login: false,
      }),
      { workspace, requestContext, observe: noopObserve },
    );
    assert.ok(result && !isValidationError(result));
    assert.equal(result.exit_code, 0);
    return JSON.parse(result.output);
  };
  const [alice, bob] = await Promise.all([run('alice'), run('bob', true)]);
  assert.equal(await localApi.authenticate(`Bearer ${alice.token}`), 'alice');
  assert.equal(await localApi.authenticate(`Bearer ${bob.token}`), 'bob');
  assert.equal(alice.url, 'http://127.0.0.1:3000/api');
  assert.deepEqual(await run(), { token: '', url: '' });
  assert.deepEqual(await run('system'), { token: '', url: '' });
  assert.equal(process.env.APP_API_TOKEN, undefined);
  assert.equal(workspace.sandbox?.getEnv().APP_API_TOKEN, undefined);
});

test('native shared-thread turns inject the message author rather than the thread creator', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runner-api-env-')));
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false } });
  const mastra = new Mastra({ storage, logger: false });
  const authors: Array<string | undefined> = [];
  class ObservedLocalApi extends LocalApiAccess {
    override environment(author: string | undefined) {
      authors.push(author);
      return super.environment(author);
    }
  }
  const localApi = new ObservedLocalApi(
    'http://127.0.0.1:3000/api',
    async () => true,
  );
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => {
      const call = calls++;
      const command = call % 2 === 0;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (command)
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `command-${call}`,
                toolName: 'exec_command',
                input: JSON.stringify({
                  cmd: `${quote(process.execPath)} -e ${quote('console.log(process.env.APP_API_TOKEN && process.env.APP_THREAD_ID && process.env.APP_PROJECT_ID ? "credentials-ready" : "credentials-missing")')}`,
                  login: false,
                }),
              });
            else {
              controller.enqueue({ type: 'text-start', id: 'reply' });
              controller.enqueue({
                type: 'text-delta',
                id: 'reply',
                delta: 'Done',
              });
              controller.enqueue({ type: 'text-end', id: 'reply' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: command ? 'tool-calls' : 'stop',
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
        toolCall: true,
      }),
    } as unknown as LanguageModelService,
    root,
    undefined,
    { buildTools: async () => ({ exec_command: execCommand }) },
    undefined,
    undefined,
    undefined,
    undefined,
    localApi,
  );
  const service = new ThreadService(memory, runner, {
    assertMember: async () => ({ role: 'member' as const }),
  });
  t.after(async () => {
    await service.shutdown();
    await mastra.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const settings = { model: null, reasoningEffort: 'auto' } as const;
  const thread = await service.createThread('creator', {
    ...settings,
    title: 'Shared',
    projectId: 'project000000001',
  });
  for (const [index, author] of ['alice', 'bob'].entries()) {
    await service.run(author, thread.id, {
      ...settings,
      id: `message0${index}`,
      createdBy: author,
      isImmediate: false,
      parts: [{ type: 'text', text: 'Run a command' }],
    });
    let snapshot = await service.getThread(author, thread.id);
    for (let i = 0; i < 300 && snapshot.thread.status !== 'success'; i++) {
      await delay(10);
      snapshot = await service.getThread(author, thread.id);
    }
    assert.equal(
      snapshot.thread.status,
      'success',
      JSON.stringify(snapshot.thread),
    );
    assert.match(JSON.stringify(snapshot.messages), /credentials-ready/);
    assert.equal(authors[index], author);
  }
  assert.deepEqual(authors, ['alice', 'bob']);
});
