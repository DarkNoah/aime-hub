import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { automationInputSchema } from '@aime/shared/automations';
import {
  fixture,
  input,
  personal,
  project,
  system,
  until,
} from './test-fixture.js';

test('automation step limits accept only the presets and default to unlimited', () => {
  const legacy: Record<string, unknown> = { ...input };
  delete legacy.maxSteps;
  assert.equal(automationInputSchema.parse(legacy).maxSteps, null);
  for (const maxSteps of [null, 50, 100, 200, 300]) {
    const parsed = automationInputSchema.parse({ ...input, maxSteps });
    assert.equal(parsed.maxSteps, maxSteps);
    assert.equal(JSON.parse(JSON.stringify(parsed)).maxSteps, maxSteps);
  }
  for (const maxSteps of [
    0,
    -1,
    49,
    51,
    100.5,
    301,
    Infinity,
    '50',
    'unlimited',
  ])
    assert.equal(
      automationInputSchema.safeParse({ ...input, maxSteps }).success,
      false,
    );
});

test('step limits persist across edits in every scope and older schedules default to unlimited', async (t) => {
  const { service, mastra } = await fixture(t);
  for (const scope of [personal, project, system]) {
    const user = scope.scope === 'personal' ? 'alice' : 'admin';
    const task = await service.create(user, scope, input);
    assert.equal(task.maxSteps, null);
    for (const maxSteps of [50, 100, 200, 300, null] as const) {
      const saved = await service.update(user, task.id, { ...input, maxSteps });
      assert.equal(saved.maxSteps, maxSteps);
      assert.equal(
        (await service.list(user, scope)).items[0].maxSteps,
        maxSteps,
      );
      assert.equal(
        automationInputSchema.parse(
          (await mastra.schedules.get(task.id))?.metadata?.data,
        ).maxSteps,
        maxSteps,
      );
    }
    const schedule = (await mastra.schedules.get(task.id))!;
    const data: Record<string, unknown> = { ...input };
    delete data.maxSteps;
    await mastra.schedules.update(task.id, {
      metadata: { ...schedule.metadata, data },
    });
    assert.equal((await service.list(user, scope)).items[0].maxSteps, null);
    assert.equal((await service.prepare(task.id)).maxSteps, null);
  }
});

for (const maxSteps of [50, 100, 200, 300, null] as const) {
  test(
    `native automation execution honors ${maxSteps ?? 'unlimited'} steps`,
    { timeout: 30000 },
    async (t) => {
      let calls = 0;
      let toolCalls = 0;
      const model = createMockModel({ mockText: 'Done', version: 'v2' });
      t.mock.method(model, 'doStream', async () => ({
        stream: new ReadableStream({
          start(controller) {
            const continuing = ++calls <= 300;
            if (continuing) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `next-${calls}`,
                toolName: 'next',
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
              finishReason: continuing ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      }));
      const { service, mastra } = await fixture(t, {
        model,
        tools: {
          next: createTool({
            id: 'next',
            description: 'Continue to the next step',
            inputSchema: z.object({}),
            execute: async () => ({ count: ++toolCalls }),
          }),
        },
      });
      const task = await service.create('alice', personal, input);
      await service.update('alice', task.id, { ...input, maxSteps });
      // Enter through the native schedule worker, including metadata resolution.
      await mastra.schedules.run(task.id);
      const history = await until(
        () => service.history('alice', task.id),
        (rows) =>
          rows.some((row) => ['succeeded', 'failed'].includes(row.status)),
      );
      assert.equal(calls, maxSteps ?? 301);
      assert.equal(toolCalls, maxSteps ?? 300);
      assert.equal(
        history[0].status,
        maxSteps === null ? 'succeeded' : 'failed',
      );
      assert.equal(
        history[0].error,
        maxSteps === null ? null : 'AUTOMATION_RUN_FAILED',
      );
      if (maxSteps === null) assert.equal(history[0].text, 'Done');
    },
  );
}
