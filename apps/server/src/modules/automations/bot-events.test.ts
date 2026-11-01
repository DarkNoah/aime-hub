import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import {
  isValidationError,
  noopObserve,
  type ToolExecutionContext,
  type ValidationError,
} from '@mastra/core/tools';
import {
  automationInputSchema,
  automationPatchSchema,
} from '@aime/shared/automations';
import type { GroupChatDetail } from '@aime/shared/group-chats';
import { createAutomationTools } from '../../mastra/tools/automations.js';
import { fixture, input, personal } from './test-fixture.js';

function context(): ToolExecutionContext {
  return {
    requestContext: new RequestContext([['userId', 'alice']]),
    observe: noopObserve,
  };
}
async function call<T>(
  tool: {
    execute?: (
      input: never,
      context: ToolExecutionContext,
    ) => Promise<T | ValidationError | void>;
  },
  value: unknown,
  ctx = context(),
): Promise<T> {
  const output = await tool.execute!(value as never, ctx);
  assert.ok(output && !isValidationError(output), JSON.stringify(output));
  return output as T;
}

test('public automation input cannot forge a result destination', () => {
  assert.equal(
    automationInputSchema.safeParse({ ...input, sourceRoomId: 'forged' })
      .success,
    false,
  );
  assert.equal(
    automationPatchSchema.safeParse({ sourceRoomId: 'forged' }).success,
    false,
  );
});

test('room creation captures server provenance, removes the hidden Bot config and retains provenance on edits', async (t) => {
  const sources: string[] = [];
  const { service, mastra } = await fixture(t, {
    botEvents: {
      async validateSource(userId, scope, roomId) {
        assert.equal(userId, 'alice');
        assert.deepEqual(scope, personal);
        sources.push(roomId);
        return { id: roomId, projectId: null } as GroupChatDetail;
      },
      async publish() {
        assert.fail('Saving a task must not wake the Bot');
      },
    },
  });
  const ctx = context();
  ctx.requestContext!.set('automationSourceRoomId', 'source-room');
  ctx.requestContext!.set('chatSettings', {
    agentId: 'code:bot-agent',
    model: 'fixture/model',
    reasoningEffort: 'high',
  });
  const tools = createAutomationTools(() => service);
  const { automation: task } = await call(tools.automation_save, input, ctx);
  assert.equal(task.sourceRoomId, 'source-room');
  assert.deepEqual(sources, ['source-room']);
  // Omit settings so creation actually inherits the Bot's configuration.
  const withoutSettings = {
    name: input.name,
    prompt: input.prompt,
    cron: input.cron,
    enabled: false,
  };
  const inherited = (await call(tools.automation_save, withoutSettings, ctx))
    .automation;
  assert.equal(inherited.settings.agentId, null);
  assert.equal(inherited.settings.model, 'fixture/model');
  assert.equal(inherited.settings.reasoningEffort, 'high');
  await call(tools.automation_save, { id: task.id, name: 'Renamed' });
  await service.update('alice', task.id, { ...input, name: 'Page edit' });
  assert.equal(
    (await service.get('alice', task.id)).sourceRoomId,
    'source-room',
  );
  assert.equal(
    (await mastra.schedules.get(task.id))?.metadata?.sourceRoomId,
    'source-room',
  );
  assert.equal(
    automationPatchSchema.safeParse({ sourceRoomId: 'forged' }).success,
    false,
  );
});
