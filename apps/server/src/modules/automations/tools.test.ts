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
  automationPatchSchema,
  automationToolNames,
} from '@aime/shared/automations';
import { createAutomationTools } from '../../mastra/tools/automations.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import {
  buildTools,
  parseToolConfig,
  registeredToolIds,
} from '../tools/registry.js';
import {
  fixture,
  input,
  personal,
  project,
  system,
  until,
} from './test-fixture.js';
import { systemTimezone } from './metadata.js';

function context(userId = 'alice', projectId?: string): ToolExecutionContext {
  const requestContext = new RequestContext();
  requestContext.set('userId', userId);
  requestContext.set('projectId', projectId);
  requestContext.set('chatSettings', {
    agentId: null,
    model: 'fixture/model',
    reasoningEffort: 'high',
  });
  return { requestContext, observe: noopObserve };
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

test('automation tools create native schedules with inherited settings and discoverable state', async (t) => {
  const { service, mastra, memory } = await fixture(t);
  const tools = createAutomationTools(() => service);
  const { automation: task } = await call(tools.automation_save, {
    name: 'Daily digest',
    prompt: 'Summarize the project',
    cron: '0 9 * * *',
    settings: { reasoningEffort: 'low' },
  });
  assert.equal(task.enabled, true);
  assert.equal(task.timezone, systemTimezone());
  assert.deepEqual(task.settings, {
    agentId: null,
    model: 'fixture/model',
    reasoningEffort: 'low',
  });
  assert.deepEqual(task.scope, personal);
  assert.equal(task.createdBy, 'alice');
  assert.equal(task.threadCreated, false);
  assert.equal(await memory.getThreadById({ threadId: task.threadId }), null);
  assert.equal(
    (await mastra.schedules.get(task.id))?.agentId,
    'scheduled-task',
  );
  const listed = await call(tools.automation_list, {});
  assert.equal(listed.items[0].id, task.id);
  assert.equal(listed.canManage, true);
  assert.equal(listed.timezone, task.timezone);
  assert.deepEqual(
    (await call(tools.automation_get, { id: task.id })).automation,
    task,
  );
});

test('partial edits preserve paused state, nested settings and options; concurrent edits merge', async (t) => {
  const { service } = await fixture(t);
  const tools = createAutomationTools(() => service);
  const task = await service.create('alice', personal, {
    ...input,
    enabled: true,
    maxSteps: 200,
    separateThread: true,
    desktopNotification: true,
    settings: {
      agentId: 'assistant',
      model: 'fixture/model',
      reasoningEffort: 'high',
    },
  });
  await call(tools.automation_save, { id: task.id, enabled: false });
  assert.deepEqual(
    automationPatchSchema.parse({
      name: 'Renamed',
      settings: { agentId: null },
    }),
    {
      name: 'Renamed',
      settings: { agentId: null },
    },
  );
  await Promise.all([
    call(tools.automation_save, {
      id: task.id,
      name: 'Renamed',
    }),
    call(tools.automation_save, {
      id: task.id,
      settings: { agentId: null },
    }),
    call(tools.automation_save, {
      id: task.id,
      prompt: 'New instructions',
    }),
  ]);
  const { automation: updated } = await call(tools.automation_get, {
    id: task.id,
  });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.prompt, 'New instructions');
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextFireAt, null);
  assert.equal(updated.maxSteps, 200);
  assert.equal(updated.separateThread, true);
  assert.equal(updated.desktopNotification, true);
  assert.deepEqual(updated.settings, {
    agentId: null,
    model: 'fixture/model',
    reasoningEffort: 'high',
  });
  const { automation: resumed } = await call(tools.automation_save, {
    id: task.id,
    enabled: true,
  });
  assert.equal(resumed.enabled, true);
  assert.ok(resumed.nextFireAt);
  // The existing management form still replaces its complete settings object.
  const replacement = await service.update('alice', task.id, {
    ...input,
    settings: { model: null, reasoningEffort: 'auto' },
  });
  assert.deepEqual(replacement.settings, {
    model: null,
    reasoningEffort: 'auto',
  });
});

test('save routes enabled-only changes through pause/resume and mixed changes through patch', async (t) => {
  const { service } = await fixture(t);
  const tools = createAutomationTools(() => service);
  const task = await service.create('alice', personal, input);
  const enabled = t.mock.method(service, 'setEnabled');
  const patch = t.mock.method(service, 'patch');
  await call(tools.automation_save, { id: task.id, enabled: true });
  await call(tools.automation_save, {
    id: task.id,
    enabled: false,
    settings: {},
  });
  assert.equal(enabled.mock.callCount(), 2);
  assert.equal(patch.mock.callCount(), 0);
  const { automation } = await call(tools.automation_save, {
    id: task.id,
    name: 'Changed and resumed',
    enabled: true,
  });
  assert.equal(patch.mock.callCount(), 1);
  assert.equal(enabled.mock.callCount(), 2);
  assert.equal(automation.name, 'Changed and resumed');
  assert.equal(automation.enabled, true);
});

test('flat scope parameters infer the current project or select one by projectId', async (t) => {
  const { service } = await fixture(t);
  const tools = createAutomationTools(() => service);
  const { automation } = await call(
    tools.automation_save,
    {
      ...input,
      projectId: project.projectId,
    },
    context('owner'),
  );
  assert.deepEqual(automation.scope, project);
  const listed = await call(
    tools.automation_list,
    { projectId: project.projectId },
    context('owner'),
  );
  assert.equal(listed.items[0].id, automation.id);
  const updated = await call(
    tools.automation_save,
    {
      id: automation.id,
      scope: 'project',
      enabled: true,
    },
    context('owner', project.projectId),
  );
  assert.equal(updated.automation.enabled, true);
  const paused = await call(
    tools.automation_save,
    {
      id: automation.id,
      enabled: false,
    },
    context('owner', project.projectId),
  );
  assert.equal(paused.automation.enabled, false);
  await assert.rejects(
    () => call(tools.automation_list, { scope: 'project' }),
    /projectId is required/,
  );
  await assert.rejects(
    () =>
      call(tools.automation_list, {
        scope: 'personal',
        projectId: project.projectId,
      }),
    /projectId can only be used with project scope/,
  );
  assert.ok(
    isValidationError(
      await tools.automation_list.execute!(
        { scope: project } as never,
        context('owner'),
      ),
    ),
  );
  assert.ok(
    isValidationError(
      await tools.automation_save.execute!(
        {
          id: automation.id,
          scope: 'project',
          projectId: project.projectId,
        } as never,
        context('owner'),
      ),
    ),
  );
});

test('tools enforce actor identity, ownership, project roles and conversation scope on all operations', async (t) => {
  const { service, users } = await fixture(t);
  const tools = createAutomationTools(() => service);
  const mine = await service.create('alice', personal, input);
  const shared = await service.create('owner', project, input);
  const global = await service.create('admin', system, input);
  const actions = [
    [tools.automation_get, {}],
    [tools.automation_save, { name: 'Attack' }],
    [tools.automation_save, { enabled: true }],
    [tools.automation_delete, {}],
    [tools.automation_run, {}],
    [tools.automation_history, {}],
  ] as const;
  for (const [tool, extra] of actions) {
    await assert.rejects(
      () => tool.execute!({ id: mine.id, ...extra } as never, context('bob')),
      { code: 'AUTOMATION_NOT_FOUND' },
    );
    await assert.rejects(
      () =>
        tool.execute!(
          { id: mine.id, ...extra } as never,
          context('alice', project.projectId),
        ),
      { code: 'AUTOMATION_NOT_FOUND' },
    );
  }
  const member = context('member', project.projectId);
  const read = await call(tools.automation_list, {}, member);
  assert.equal(read.canManage, false);
  assert.deepEqual(
    read.items.map((task) => task.id),
    [shared.id],
  );
  await call(tools.automation_get, { id: shared.id }, member);
  await call(tools.automation_history, { id: shared.id }, member);
  for (const [tool, extra] of actions.slice(1, -1))
    await assert.rejects(
      () => tool.execute!({ id: shared.id, ...extra } as never, member),
      { code: 'FORBIDDEN' },
    );
  await assert.rejects(() => call(tools.automation_save, input, member), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    () => call(tools.automation_list, { scope: 'personal' }, member),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    () =>
      call(
        tools.automation_list,
        { scope: 'project', projectId: 'other00000000000' },
        member,
      ),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(() => call(tools.automation_list, { scope: 'system' }), {
    code: 'FORBIDDEN',
  });
  assert.equal(
    (
      await call(
        tools.automation_get,
        { id: global.id, scope: 'system' },
        context('admin'),
      )
    ).automation.id,
    global.id,
  );
  users.get('alice')!.banned = true;
  await assert.rejects(() => call(tools.automation_get, { id: mine.id }), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    () => call(tools.automation_list, {}, { observe: noopObserve }),
    /authenticated user/,
  );
});

test('tool runs record native completion without resuming cadence and deletion retains messages', async (t) => {
  const { service, memory } = await fixture(t);
  const tools = createAutomationTools(() => service);
  const { automation: task } = await call(tools.automation_save, input);
  const requested = await call(tools.automation_run, { id: task.id });
  assert.equal(requested.requested, true);
  assert.equal(requested.automation.enabled, false);
  assert.equal(requested.automation.threadCreated, true);
  const history = await until(
    () => call(tools.automation_history, { id: task.id }),
    (result) => result.runs[0]?.status === 'succeeded',
  );
  assert.equal(history.runs[0].text, 'Native generated result');
  assert.equal(history.automation.enabled, false);
  assert.deepEqual(await call(tools.automation_delete, { id: task.id }), {
    id: task.id,
    deleted: true,
  });
  assert.equal((await call(tools.automation_list, {})).items.length, 0);
  assert.ok(await memory.getThreadById({ threadId: task.threadId }));
  await assert.rejects(() => call(tools.automation_get, { id: task.id }), {
    code: 'AUTOMATION_NOT_FOUND',
  });
});

test('invalid and impersonated tool inputs cannot mutate schedules', async (t) => {
  const { service } = await fixture(t);
  const tools = createAutomationTools(() => service);
  for (const value of [
    {},
    { enabled: false },
    { name: 'Missing instructions' },
    { name: 'Missing cron', prompt: 'Do work' },
  ]) {
    const result = await tools.automation_save.execute!(
      value as never,
      context(),
    );
    assert.ok(isValidationError(result));
  }
  for (const extra of [
    { ownerId: 'bob' },
    { threadId: 'other' },
    { timezone: 'UTC' },
    { settings: { userId: 'bob' } },
  ]) {
    const result = await tools.automation_save.execute!(
      { ...input, ...extra } as never,
      context(),
    );
    assert.ok(isValidationError(result));
  }
  await assert.rejects(
    () => call(tools.automation_save, { ...input, cron: 'invalid' }),
    { code: 'AUTOMATION_CRON_INVALID' },
  );
  assert.equal((await service.list('alice', personal)).items.length, 0);
  const task = await service.create('alice', personal, input);
  for (const changes of [
    {},
    { settings: {} },
    { ownerId: 'bob' },
    { settings: { model: '' } },
  ]) {
    const result = await tools.automation_save.execute!(
      { id: task.id, ...changes } as never,
      context(),
    );
    assert.ok(isValidationError(result));
  }
  await assert.rejects(
    () =>
      call(tools.automation_save, {
        ...input,
        id: 'missing-schedule',
      }),
    { code: 'AUTOMATION_NOT_FOUND' },
  );
  assert.equal((await service.list('alice', personal)).items.length, 1);
  await assert.rejects(
    () => call(createAutomationTools().automation_list, {}),
    /unavailable/,
  );
});

test('registry lazily injects automations, applies admin switches and keeps exec actor/scopes', async (t) => {
  const { service } = await fixture(t);
  const task = await service.create('alice', personal, input);
  let resolutions = 0;
  const registered = await buildTools(
    undefined,
    {},
    {
      automations: () => {
        resolutions++;
        return service;
      },
      disabledTools: ['automation_delete'],
      loadConfig: async (id) => ({ enabled: id !== 'automation_save' }),
    },
  );
  assert.equal(resolutions, 0);
  assert.ok(registeredToolIds.includes('automation_save'));
  for (const id of [
    'automation_create',
    'automation_update',
    'automation_set_enabled',
  ])
    assert.ok(!registeredToolIds.includes(id));
  for (const id of automationToolNames) {
    assert.equal(parseToolConfig(id, {}).kind, 'builtin');
    assert.equal(
      id in registered,
      !['automation_save', 'automation_delete'].includes(id),
    );
  }
  const exec = registered.exec as ReturnType<typeof createExecTool>;
  const result = await exec.execute!(
    {
      code: 'text(await tools.automation_list({})); text([typeof tools.automation_save, typeof tools.automation_delete]);',
      yield_time_ms: 3000,
      max_output_tokens: 2000,
    },
    context(),
  );
  assert.ok(result && !isValidationError(result) && !result.isError);
  const output = result.content.filter((part) => part.type === 'text');
  assert.equal(JSON.parse(output[0].text).items[0].id, task.id);
  assert.deepEqual(JSON.parse(output[1].text), ['undefined', 'undefined']);
  assert.equal(resolutions, 1);
});
