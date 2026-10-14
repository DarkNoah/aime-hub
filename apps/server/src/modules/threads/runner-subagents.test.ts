import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import type { BaseAgent } from '@aime/shared/agents';
import type { ChatSettings } from '@aime/shared/threads';
import { agentRegistry, getAgent } from '../../mastra/agents/index.js';
import { buildAgent } from '../../mastra/agents/factory.js';
import type { LanguageModelService } from '../models/language-model.js';
import type { UsageService } from '../usage/service.js';
import { createChatRunner } from './runner.js';
import { ThreadService } from './service.js';

test(
  'chat streams native delegation with scoped skills, configured child model settings and separate usage',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-subagents-');
    const skillPath = `${root}/.agents/skills/shared`;
    await mkdir(skillPath, { recursive: true });
    await writeFile(
      `${skillPath}/SKILL.md`,
      '---\nname: shared\ndescription: SHARED_SKILL_MARKER\n---\nUse the shared workspace.',
    );
    const child: BaseAgent = {
      ...getAgent('code')!,
      id: 'test:worker',
      instructions: 'CHILD_INSTRUCTIONS',
      model: 'mock/child',
      agents: {
        self: 'testWorker',
        parent: 'default',
        missing: 'not-registered',
      },
    };
    const registry = agentRegistry as Record<string, BaseAgent>;
    registry.testWorker = child;
    t.after(() => {
      delete registry.testWorker;
    });
    const parent: BaseAgent = {
      ...getAgent('default')!,
      instructions: 'PARENT_INSTRUCTIONS',
      agents: { worker: 'testWorker' },
    };
    const calls: string[] = [];
    const records: Parameters<UsageService['record']>[0][] = [];
    const childModel = new MastraLanguageModelV2Mock({
      modelId: 'child-model',
      doStream: async (options) => {
        assert.equal(
          options.tools?.some((tool) => tool.name.startsWith('agent-')) ??
            false,
          false,
        );
        calls.push('child');
        assert.match(JSON.stringify(options.prompt), /CHILD_INSTRUCTIONS/);
        assert.match(JSON.stringify(options.prompt), /SHARED_SKILL_MARKER/);
        assert.equal(options.maxOutputTokens, 4321);
        assert.equal(options.providerOptions?.openai?.reasoningEffort, 'low');
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: 'child-text' });
              controller.enqueue({
                type: 'text-delta',
                id: 'child-text',
                delta: 'CHILD_RESULT',
              });
              controller.enqueue({ type: 'text-end', id: 'child-text' });
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const parentModel = new MastraLanguageModelV2Mock({
      modelId: 'parent-model',
      doStream: async (options) => {
        const first = calls.length === 0;
        calls.push('parent');
        if (!first)
          assert.match(JSON.stringify(options.prompt), /CHILD_RESULT/);
        return {
          stream: new ReadableStream({
            start(controller) {
              if (first) {
                assert.ok(
                  options.tools?.some((tool) => tool.name === 'agent-worker'),
                );
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'delegate',
                  toolName: 'agent-worker',
                  input: JSON.stringify({ prompt: 'Execute the child task' }),
                });
              } else {
                controller.enqueue({ type: 'text-start', id: 'parent-text' });
                controller.enqueue({
                  type: 'text-delta',
                  id: 'parent-text',
                  delta: 'PARENT_RESULT',
                });
                controller.enqueue({ type: 'text-end', id: 'parent-text' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: first ? 'tool-calls' : 'stop',
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
          const isChild = settings.model === 'mock/child';
          return {
            model: isChild ? childModel : parentModel,
            reference: settings.model ?? 'mock/parent',
            providerOptions: isChild
              ? { openai: { reasoningEffort: 'low' } }
              : {},
            maxOutputTokens: isChild ? 4321 : 1234,
            supportsImages: true,
            toolCall: true,
          };
        },
      } as unknown as LanguageModelService,
      root,
      undefined,
      { buildTools: async () => ({}) },
      {
        getConfig: async () => parent,
        getAgent: async (_id, options) => buildAgent(parent, options),
      },
      {
        record: async (record: Parameters<UsageService['record']>[0]) => {
          records.push(record);
        },
      } as unknown as UsageService,
    );
    const service = new ThreadService(memory, runner);
    t.after(async () => {
      await service.shutdown();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const settings: ChatSettings = {
      model: 'mock/parent',
      reasoningEffort: 'auto',
    };
    const thread = await service.createThread('alice', {
      ...settings,
      title: 'Delegation test',
    });
    await service.run('alice', thread.id, {
      ...settings,
      id: 'message01',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Delegate the task' }],
    });
    for (let i = 0; i < 500; i++) {
      const status = (await service.getThread('alice', thread.id)).thread
        .status;
      assert.notEqual(status, 'error');
      if (status === 'success' && calls.length === 3) break;
      await delay(10);
    }
    assert.deepEqual(calls, ['parent', 'child', 'parent']);
    const childHeaders = childModel.doStreamCalls[0].headers;
    assert.equal(
      childHeaders?.['X-USER-ID'] ?? childHeaders?.['x-user-id'],
      'alice',
    );
    const childRecords = records.filter(
      (record) => record.agentId === child.id,
    );
    assert.equal(childRecords.length, 1);
    assert.equal(childRecords[0].modelReference, 'mock/child');
    assert.equal(childRecords[0].totalTokens, 20);
    assert.equal(childRecords[0].userId, 'alice');
    assert.equal(childRecords[0].threadId, thread.id);
    assert.equal(
      records.filter((record) => record.agentId === parent.id).length,
      2,
    );
  },
);
