import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fixture,
  input,
  personal,
  project,
  system,
  until,
} from './test-fixture.js';

test('native agent schedules create a thread on the first fire and reuse its persisted history', async (t) => {
  const { service, mastra, memory, threads, calls } = await fixture(t);
  for (const scope of [personal, project, system]) {
    const user = scope.scope === 'personal' ? 'alice' : 'admin';
    const task = await service.create(user, scope, {
      ...input,
      separateThread: true,
    });
    assert.match(task.threadId, /^schedule:[a-zA-Z0-9_-]{16}$/);
    const schedule = await mastra.schedules.get(task.id);
    assert.ok(schedule?.agentId);
    assert.equal(schedule?.threadId, task.threadId);
    assert.equal(schedule?.resourceId, task.resourceId);
    assert.equal(task.threadCreated, false);
    assert.equal(await memory.getThreadById({ threadId: task.threadId }), null);
    assert.equal(
      (
        await threads.listThreads(
          user,
          0,
          scope.scope === 'project' ? scope.projectId : undefined,
        )
      ).threads.length,
      0,
    );
    for (let run = 1; run <= 2; run++) {
      // Use the native worker directly for the first fire, as cron does.
      if (run === 1) await mastra.schedules.run(task.id);
      else assert.equal((await service.run(user, task.id)).threadCreated, true);
      const history = await until(
        () => service.history(user, task.id),
        (rows) =>
          rows.length === run &&
          rows.every((row) => row.status === 'succeeded'),
      );
      assert.equal(history[0].text, 'Native generated result');
      assert.equal(
        (await service.list(user, scope)).items[0].threadCreated,
        true,
      );
      assert.equal(
        (await memory.getThreadById({ threadId: task.threadId }))?.resourceId,
        task.resourceId,
      );
      const messages = await memory.recall({
        threadId: task.threadId,
        resourceId: task.resourceId,
        perPage: false,
      });
      assert.equal(
        messages.messages.filter((message) => message.role === 'assistant')
          .length,
        run,
      );
      const snapshot = await threads.getThread(user, task.threadId);
      assert.equal(
        snapshot.messages.filter((message) => message.role === 'assistant')
          .length,
        run,
      );
      assert.equal(snapshot.thread.status, 'success');
    }
    assert.equal(
      (await service.list(user, scope)).items[0].threadId,
      task.threadId,
    );
  }
  assert.ok(calls.some((call) => call.userId === 'system'));
  assert.ok(calls.some((call) => call.projectId === project.projectId));
});
