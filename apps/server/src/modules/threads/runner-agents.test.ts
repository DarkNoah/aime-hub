import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { AdminAgent } from '@aime/shared/agents';
import type { ChatSettings } from '@aime/shared/threads';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';
import { buildAgent } from '../../mastra/agents/factory.js';
import { fallbackAgentId } from '../../mastra/agents/index.js';
import { buildTools } from '../tools/service.js';

test('runtime resolves registered names and persisted IDs without an AgentService', async (t) => {
  const mastra = new Mastra({ storage: new InMemoryStore(), logger: false });
  t.after(() => mastra.shutdown());
  const runner = createChatRunner(
    mastra,
    {} as LanguageModelService,
    '/tmp/runner-agent-registry',
  );
  const settings: ChatSettings = { model: null, reasoningEffort: 'auto' };
  for (const agentId of ['code', fallbackAgentId, undefined]) {
    const selected = { ...settings, agentId };
    assert.equal(
      (await runner.resolveSettings!(selected)).agentId,
      fallbackAgentId,
    );
    assert.equal(await runner.sessionKey!(selected), `${fallbackAgentId}:code`);
  }
  await assert.rejects(
    runner.resolveSettings!({ ...settings, agentId: 'missing' }),
    { code: 'AGENT_NOT_FOUND' },
  );
});

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Agent run did not settle');
}

test(
  'runtime resolves agent configs, filters skills and automatically injects globally enabled tools, pins queued work and switches only when idle',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-agents-');
    for (const name of ['selected', 'unselected']) {
      const path = `${root}/.agents/skills/${name}`;
      await mkdir(path, { recursive: true });
      await writeFile(
        `${path}/SKILL.md`,
        `---\nname: ${name}\ndescription: ${name} skill marker\n---\nFollow ${name} instructions.`,
      );
    }
    const first: AdminAgent = {
      id: 'code:first',
      source: 'database',
      status: 'published',
      versionId: 'version-one',
      versionNumber: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: 'First',
      description: '',
      instructions: 'FIRST_AGENT_INSTRUCTIONS',
      model: 'mock/fixed',
      tools: ['curr_time'],
      disabledTools: ['sleep'],
      skillsMode: 'custom',
      skillPaths: ['selected'],
      agents: {},
    };
    const second: AdminAgent = {
      ...first,
      id: 'code:second',
      source: 'code',
      name: 'Second',
      instructions: 'SECOND_AGENT_INSTRUCTIONS',
      model: null,
      tools: ['sleep'],
      disabledTools: ['curr_time'],
      skillsMode: 'auto',
      skillPaths: [],
    };
    const lookups: Array<string | null | undefined> = [];
    const toolSelections: (readonly string[] | undefined)[] = [];
    const models: Array<string | null> = [];
    const requests: Array<{
      prompt: string;
      tools: string[];
      model: string | null | undefined;
    }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MastraLanguageModelV2Mock({
      doStream: async (options) => {
        requests.push({
          prompt: JSON.stringify(options.prompt),
          model: models.at(-1),
          tools: options.tools?.map((tool) => tool.name) ?? [],
        });
        if (requests.length === 1) await gate;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 'reply' });
              controller.enqueue({
                type: 'text-delta',
                id: 'reply',
                delta: 'Done',
              });
              controller.enqueue({ type: 'text-end', id: 'reply' });
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, logger: false });
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const runner = createChatRunner(
      mastra,
      {
        getLanguageModel: async (_user: string, settings: ChatSettings) => {
          models.push(settings.model);
          return {
            model,
            reference: settings.model ?? 'mock/default',
            providerOptions: {},
            supportsImages: true,
            toolCall: true,
          };
        },
      } as unknown as LanguageModelService,
      root,
      undefined,
      {
        buildTools: async (ids, defaults, disabledTools) => {
          toolSelections.push(ids);
          return buildTools(ids, defaults, { disabledTools });
        },
      },
      {
        getAgent: async (id, options) =>
          buildAgent(id === first.id ? first : second, options),
        getConfig: async (id) => {
          lookups.push(id);
          return !id || id === first.id ? first : second;
        },
      },
    );
    const service = new ThreadService(memory, runner);
    t.after(async () => {
      release();
      await service.shutdown();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const settings: ChatSettings = {
      model: 'mock/chat',
      reasoningEffort: 'auto',
    };
    const thread = await service.createThread('alice', {
      ...settings,
      title: 'Agent configuration test',
    });
    assert.equal(thread.agentId, first.id);
    const send = (id: string, agentId?: string) =>
      service.run('alice', thread.id, {
        ...settings,
        agentId,
        id,
        isImmediate: false,
        parts: [{ type: 'text', text: id }],
      });
    await send('message01');
    await until(() => requests.length === 1);
    await assert.rejects(send('message02', second.id), {
      code: 'AGENT_CHANGE_BUSY',
    });
    await send('message03', first.id);
    release();
    await until(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
          'success' && requests.length >= 2,
    );
    assert.ok(lookups.includes(undefined));
    assert.ok(
      requests.every((request) => request.model === 'mock/fixed'),
      'Queued requests keep the fixed agent model',
    );
    assert.match(requests[0].prompt, /FIRST_AGENT_INSTRUCTIONS/);
    assert.match(requests[0].prompt, /selected skill marker/);
    assert.doesNotMatch(requests[0].prompt, /unselected skill marker/);
    assert.ok(requests[0].tools.includes('curr_time'));
    assert.ok(!requests[0].tools.includes('sleep'));
    assert.ok(requests[0].tools.includes('web_fetch'));
    assert.ok(toolSelections.length > 0);
    assert.ok(toolSelections.every((ids) => ids === undefined));
    const previousCount = requests.length;
    await send('message04', second.id);
    await until(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
          'success' && requests.length > previousCount,
    );
    const last = requests.at(-1)!;
    assert.match(last.prompt, /SECOND_AGENT_INSTRUCTIONS/);
    assert.doesNotMatch(last.prompt, /FIRST_AGENT_INSTRUCTIONS/);
    assert.match(last.prompt, /selected skill marker/);
    assert.match(last.prompt, /unselected skill marker/);
    assert.ok(last.tools.includes('sleep'));
    assert.ok(!last.tools.includes('curr_time'));
    assert.equal(toolSelections.at(-1), undefined);
    assert.equal(models.at(-1), 'mock/chat');
    assert.equal(
      (await service.getThread('alice', thread.id)).thread.agentId,
      second.id,
    );
    const agents = (await storage.getStore('agents'))!;
    assert.equal(await agents.getById(first.id), null);
    assert.equal(await agents.getById(second.id), null);
  },
);

test(
  'tool replies retain the constructed agent after its stored configuration changes',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-agent-resume-');
    const storage = new InMemoryStore();
    const mastra = new Mastra({ storage, logger: false });
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const original: AdminAgent = {
      agents: {},
      source: 'database',
      id: 'stored-agent',
      name: 'Original',
      description: '',
      instructions: 'ORIGINAL_CONFIGURATION',
      model: null,
      tools: ['ask_user'],
      disabledTools: [],
      skillsMode: 'custom',
      skillPaths: [],
      status: 'published',
      versionId: 'version-one',
      versionNumber: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let latest = original;
    const prompts: string[] = [];
    const model = new MastraLanguageModelV2Mock({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        const ask = prompts.length === 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              if (ask)
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'question',
                  toolName: 'ask_user',
                  input: JSON.stringify({
                    question: 'Continue?',
                    options: [{ label: 'Yes' }],
                  }),
                });
              else {
                controller.enqueue({ type: 'text-start', id: 'answer' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'answer',
                  delta: 'Continued',
                });
                controller.enqueue({ type: 'text-end', id: 'answer' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: ask ? 'tool-calls' : 'stop',
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
          reference: 'mock/model',
          providerOptions: {},
          supportsImages: true,
          toolCall: false,
        }),
      } as unknown as LanguageModelService,
      root,
      undefined,
      undefined,
      {
        getConfig: async () => structuredClone(latest),
        getAgent: async (_id, options) =>
          buildAgent(
            options.versionId === original.versionId ? original : latest,
            options,
          ),
      },
    );
    const service = new ThreadService(memory, runner);
    t.after(async () => {
      await service.shutdown();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const settings = {
      agentId: original.id,
      model: null,
      reasoningEffort: 'auto',
    } as const;
    const thread = await service.createThread('alice', {
      ...settings,
      title: 'Pinned configuration',
    });
    await service.run('alice', thread.id, {
      ...settings,
      id: 'message01',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Ask' }],
    });
    await until(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
        'suspended',
    );
    latest = {
      ...original,
      versionId: 'version-two',
      versionNumber: 2,
      instructions: 'UPDATED_CONFIGURATION',
    };
    const pending = (
      await service.getThread('alice', thread.id)
    ).toolInteractions!.find((item) => !item.response)!;
    await service.respondToTool('alice', thread.id, pending.id, {
      id: 'response1',
      action: 'resume',
      data: 'Yes',
    });
    await until(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
        'success',
    );
    assert.match(prompts.at(-1)!, /ORIGINAL_CONFIGURATION/);
    assert.doesNotMatch(prompts.at(-1)!, /UPDATED_CONFIGURATION/);
    await service.run('alice', thread.id, {
      ...settings,
      id: 'message02',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Next' }],
    });
    await until(
      async () =>
        (await service.getThread('alice', thread.id)).thread.status ===
          'success' && prompts.length >= 3,
    );
    assert.match(prompts.at(-1)!, /UPDATED_CONFIGURATION/);
    assert.doesNotMatch(prompts.at(-1)!, /ORIGINAL_CONFIGURATION/);
  },
);
