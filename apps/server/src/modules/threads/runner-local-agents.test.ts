import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import type { LanguageModelService } from '../models/language-model.js';
import type { ChatSessionEvent } from './session.js';
import { createChatRunner } from './runner.js';

for (const projectId of [undefined, 'project123456789']) {
  test(
    `chat automatically delegates to ${projectId ? 'project' : 'personal'} Markdown agents and refreshes edits in an open session`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp('/tmp/runner-local-agents-');
      const put = async (path: string, content: string) => {
        const target = join(root, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      };
      const config = (body: string, enabled = true) =>
        `---\nname: Local reviewer\ndescription: Review local files\nenabled: ${enabled}\n---\n${body}`;
      const scoped = projectId
        ? `projects/${projectId}/.agents/agents`
        : 'users/alice/.agents/agents';
      await put('.agents/agents/global.md', config('GLOBAL_INSTRUCTIONS'));
      await put('.agents/agents/reviewer.md', config('GLOBAL_REVIEWER'));
      await put('.agents/agents/masked.md', config('GLOBAL_MASKED'));
      await put(`${scoped}/masked.md`, config('SCOPED_DISABLED', false));
      await put('users/alice/.agents/agents/personal.md', config('PERSONAL'));
      await put(
        'projects/project123456789/.agents/agents/project.md',
        config('PROJECT'),
      );
      await put('users/bob/.agents/agents/private.md', config('PRIVATE'));
      await put(`${scoped}/reviewer.md`, config('LOCAL_FIRST'));
      await put(
        '.agents/skills/shared/SKILL.md',
        '---\nname: shared\ndescription: SHARED_LOCAL_SKILL\n---\nShared instructions',
      );
      let expectedInstructions = 'LOCAL_FIRST';
      let enabled = true;
      let delegateNext = true;
      const calls: string[] = [];
      const model = new MastraLanguageModelV2Mock({
        doStream: async (options) => {
          const names = options.tools?.map((tool) => tool.name) ?? [];
          const parent = names.includes('agent-global');
          calls.push(parent ? 'parent' : 'child');
          if (parent) {
            assert.equal(names.includes('agent-reviewer'), enabled);
            assert.equal(names.includes('agent-personal'), !projectId);
            assert.equal(names.includes('agent-project'), !!projectId);
            assert.equal(names.includes('agent-private'), false);
            assert.equal(names.includes('agent-masked'), false);
          } else {
            assert.equal(
              names.some((name) => name.startsWith('agent-')),
              false,
            );
            assert.match(
              JSON.stringify(options.prompt),
              new RegExp(expectedInstructions),
            );
            assert.match(JSON.stringify(options.prompt), /SHARED_LOCAL_SKILL/);
          }
          const delegate = parent && enabled && delegateNext;
          if (delegate) delegateNext = false;
          return {
            stream: new ReadableStream({
              start(controller) {
                if (delegate) {
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: `delegate-${calls.length}`,
                    toolName: 'agent-reviewer',
                    input: JSON.stringify({ prompt: 'Review the workspace' }),
                  });
                } else {
                  controller.enqueue({ type: 'text-start', id: 'reply' });
                  controller.enqueue({
                    type: 'text-delta',
                    id: 'reply',
                    delta: parent ? 'Done' : 'Reviewed',
                  });
                  controller.enqueue({ type: 'text-end', id: 'reply' });
                }
                controller.enqueue({
                  type: 'finish',
                  finishReason: delegate ? 'tool-calls' : 'stop',
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
      const runner = createChatRunner(
        mastra,
        {
          getLanguageModel: async () => ({
            model,
            reference: 'mock/local',
            providerOptions: {},
            toolCall: true,
          }),
        } as unknown as LanguageModelService,
        root,
        undefined,
        { buildTools: async () => ({}) },
      );
      t.after(async () => {
        await mastra.shutdown();
        await rm(root, { recursive: true, force: true });
      });
      const thread = {
        id: 'localagentthread',
        resourceId: projectId ? `project:${projectId}` : 'user:alice',
        title: 'Local agent test',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          createdBy: 'alice',
          workspace: await runner.createWorkspace('alice', projectId),
        },
      };
      const store = (await storage.getStore('memory'))!;
      await store.saveThread({ thread });
      const events: ChatSessionEvent[] = [];
      const settings = {
        model: 'mock/local',
        reasoningEffort: 'auto',
      } as const;
      const session = await runner.open({
        thread,
        settings,
        onEvent: (event) => events.push(event),
      });
      try {
        const send = async (id: string) => {
          const offset = events.length;
          await session.send({
            ...settings,
            id,
            isImmediate: false,
            parts: [{ type: 'text', text: 'Review the files' }],
          });
          for (let i = 0; i < 500; i++) {
            const recent = events.slice(offset);
            const error = recent.find((event) => event.type === 'error');
            if (error?.type === 'error') throw error.error;
            if (
              recent.some(
                (event) =>
                  event.type === 'status' && event.status === 'success',
              )
            )
              return;
            await delay(10);
          }
          assert.fail('Run did not finish');
        };
        await send('localmessage01');
        expectedInstructions = 'LOCAL_UPDATED';
        delegateNext = true;
        await put(`${scoped}/reviewer.md`, config(expectedInstructions));
        await send('localmessage02');
        enabled = false;
        await put(`${scoped}/reviewer.md`, config(expectedInstructions, false));
        await send('localmessage03');
        assert.deepEqual(calls, [
          'parent',
          'child',
          'parent',
          'parent',
          'child',
          'parent',
          'parent',
        ]);
      } finally {
        await session.close();
      }
    },
  );
}
