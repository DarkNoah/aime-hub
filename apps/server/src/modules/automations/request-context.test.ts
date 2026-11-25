import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { createExecTool } from '../../mastra/tools/exec.js';
import { createKnowledgeTools } from '../../mastra/tools/knowledge.js';
import type { KnowledgeService } from '../knowledge/service.js';
import {
  fixture,
  input,
  personal,
  project,
  system,
  until,
} from './test-fixture.js';

test('scheduled tools retain their workspace with toolCall=false and receive the creator and project on concurrent and repeated runs', async (t) => {
  const model = createMockModel({ mockText: 'Done', version: 'v2' });
  assert.equal(model.specificationVersion, 'v2');
  const steps = new Map<string, number>();
  t.mock.method(
    model,
    'doStream',
    async ({ headers }: { headers?: Record<string, string | undefined> }) => {
      const threadId = headers?.['x-thread-id'];
      assert.ok(threadId);
      const step = (steps.get(threadId) ?? 0) + 1;
      steps.set(threadId, step);
      const callTool = step % 2 === 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (callTool) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `${threadId}-${step}`,
                toolName: 'knowledge_list',
                input: '{}',
              });
            } else {
              controller.enqueue({ type: 'text-start', id: 'done' });
              controller.enqueue({
                type: 'text-delta',
                id: 'done',
                delta: 'Done',
              });
              controller.enqueue({ type: 'text-end', id: 'done' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: callTool ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  );
  const actors: { userId: string; projectId?: string }[] = [];
  const knowledge = {
    async listContext(userId: string, projectId?: string) {
      actors.push({ userId, projectId });
      return [];
    },
  } as unknown as KnowledgeService;
  const knowledgeTool = createKnowledgeTools(knowledge).knowledge_list;
  const execute = knowledgeTool.execute!;
  knowledgeTool.execute = async (...args) => {
    assert.ok(args[1]?.workspace?.filesystem);
    return execute(...args);
  };
  const { service, mastra } = await fixture(t, {
    model,
    tools: { knowledge_list: knowledgeTool },
  });
  const tasks = [
    await service.create('alice', personal, input),
    await service.create('bob', personal, input),
    await service.create('owner', project, input),
    await service.create('admin', system, input),
  ];
  for (let run = 1; run <= 2; run++) {
    // Enter through the native scheduler, as cron does, without HTTP auth context.
    await Promise.all(tasks.map((task) => mastra.schedules.run(task.id)));
    await Promise.all(
      tasks.map(async (task) => {
        const history = await until(
          () => service.history(task.createdBy, task.id),
          (rows) =>
            rows.length === run &&
            rows.every((row) => ['succeeded', 'failed'].includes(row.status)),
        );
        assert.ok(
          history.every((row) => row.status === 'succeeded'),
          JSON.stringify(history),
        );
      }),
    );
    assert.equal(actors.length, tasks.length * run);
    for (const task of tasks) {
      const expected = {
        userId: task.createdBy,
        projectId:
          task.scope.scope === 'project' ? task.scope.projectId : undefined,
      };
      assert.deepEqual(
        actors.filter((actor) => actor.userId === task.createdBy),
        Array.from({ length: run }, () => expected),
      );
    }
  }
});

test('cron and Run Now use the personal or project browser profile of the automation', async (t) => {
  const exec = createExecTool({ getTools: async () => [] });
  const execute = t.mock.fn(exec.execute!);
  exec.execute = execute;
  const { service, mastra, store, model, browsers } = await fixture(t, {
    tools: { exec },
  });
  const bind = t.mock.method(browsers, 'execForThread');
  const called = new Set<string>();
  t.mock.method(
    model,
    'doStream',
    async ({ headers }: { headers?: Record<string, string | undefined> }) => {
      const threadId = headers?.['x-thread-id'];
      assert.ok(threadId);
      const first = !called.has(threadId);
      called.add(threadId);
      return {
        stream: new ReadableStream({
          start(controller) {
            if (first) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `browser-${threadId}`,
                toolName: 'exec',
                input: JSON.stringify({
                  code: "import { browser } from 'browser'; text(await browser.tabs());",
                }),
              });
            } else {
              controller.enqueue({ type: 'text-start', id: 'done' });
              controller.enqueue({
                type: 'text-delta',
                id: 'done',
                delta: 'Done',
              });
              controller.enqueue({ type: 'text-end', id: 'done' });
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
  );

  const personalTask = await service.create('alice', personal, input);
  const projectTask = await service.create('owner', project, {
    ...input,
    enabled: true,
  });
  const systemTask = await service.create('admin', system, {
    ...input,
    enabled: true,
  });
  const schedules = (await store.getStore('schedules'))!;
  for (const task of [projectTask, systemTask]) {
    await schedules.updateSchedule(task.id, { nextFireAt: Date.now() - 1000 });
  }
  await mastra.scheduler!.tick();
  await service.run('alice', personalTask.id, personal);

  const tasks = [personalTask, projectTask, systemTask];
  await Promise.all(
    tasks.map(async (task) => {
      const [run] = await until(
        () => service.history(task.createdBy, task.id),
        (rows) =>
          rows.some(
            (row) => row.status === 'succeeded' || row.status === 'failed',
          ),
      );
      assert.equal(run.status, 'succeeded', JSON.stringify(run));
    }),
  );

  const bindings = new Map(
    bind.mock.calls.map(({ arguments: [threadId, ...args] }) => [
      threadId,
      args,
    ]),
  );
  assert.deepEqual(
    bindings,
    new Map([
      [
        personalTask.threadId,
        ['alice', undefined, undefined],
      ],
      [
        projectTask.threadId,
        ['owner', project.projectId, undefined],
      ],
      [
        systemTask.threadId,
        ['system', undefined, { profileId: systemTask.threadId }],
      ],
    ]),
  );
  assert.equal(execute.mock.callCount(), tasks.length);
  for (const { result } of execute.mock.calls) {
    assert.deepEqual(await result, { content: [{ type: 'text', text: '[]' }] });
  }
});
