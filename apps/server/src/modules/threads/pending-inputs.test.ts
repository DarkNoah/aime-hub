import assert from 'node:assert/strict';
import test from 'node:test';
import type { SendAgentMessageResult } from '@mastra/core/agent';
import type { RunInput } from '@aime/shared/threads';
import { PendingInputs } from './pending-inputs.js';

const input = (id: string): RunInput => ({
  id,
  model: null,
  reasoningEffort: 'auto',
  isImmediate: false,
  parts: [{ type: 'text', text: id }],
});
function fixture() {
  const native = new Map<string, RunInput>();
  const submitted: RunInput[] = [];
  let sequence = 0;
  let failPrepare = false;
  let rejectId = '';
  const signals = new Map<string, string>();
  const cancelled: string[][] = [];
  const drafts = new PendingInputs(
    async (value) => {
      if (failPrepare) throw new Error('Model unavailable');
      return () => {
        const id = `signal-${++sequence}`;
        signals.set(value.id, id);
        submitted.push(value);
        if (value.id !== rejectId) native.set(id, value);
        return {
          signal: { id },
          accepted:
            value.id === rejectId
              ? Promise.reject(new Error('Admission failed'))
              : Promise.resolve({ action: 'deliver', runId: 'run' }),
        } as unknown as SendAgentMessageResult<unknown>;
      };
    },
    (ids) => {
      const removed = ids.filter((id) => native.delete(id));
      cancelled.push(removed);
      return { cancelledSignalIds: removed };
    },
    () => {},
    () => {
      assert.fail('No wake in this controlled fixture');
    },
  );
  return {
    drafts,
    native,
    submitted,
    signals,
    cancelled,
    failPreparation: () => {
      failPrepare = true;
    },
    reject: (id: string) => {
      rejectId = id;
    },
  };
}

test('preparation failure does not cancel or change any native input', async () => {
  const f = fixture();
  await f.drafts.send(input('message01'));
  f.failPreparation();
  await assert.rejects(
    f.drafts.update('message01', { text: 'edited' }),
    /Model unavailable/,
  );
  assert.equal(f.cancelled.length, 0);
  assert.equal(f.drafts.detail('message01').text, 'message01');
});

for (const started of ['message02', 'message03']) {
  test(`reordering restores only confirmed cancellations when ${started} has begun execution`, async () => {
    const f = fixture();
    for (const id of ['message01', 'message02', 'message03'])
      await f.drafts.send(input(id));
    f.native.delete(f.signals.get(started)!); // Native execution wins before its echo reaches the UI cache.
    await assert.rejects(f.drafts.move('message03', 'message02'), {
      code: 'QUEUED_MESSAGE_NOT_FOUND',
    });
    assert.deepEqual(
      [...f.native.values()].map((value) => value.id),
      [
        'message01',
        ...['message02', 'message03'].filter((id) => id !== started),
      ],
    );
    assert.equal(
      f.submitted.filter((value) => value.id === started).length,
      1,
      'Already running input must never be submitted again',
    );
  });
}

test('failed resubmission retains an inert draft until explicitly retried', async () => {
  const f = fixture();
  await f.drafts.send(input('message01'));
  await f.drafts.send(input('message02'));
  f.reject('message01');
  await assert.rejects(f.drafts.update('message01', { text: 'edited' }), {
    code: 'QUEUE_UPDATE_FAILED',
  });
  assert.equal(
    f.drafts.summaries().find((item) => item.id === 'message01')?.failed,
    true,
  );
  assert.equal(f.drafts.detail('message01').text, 'edited');
  assert.deepEqual(
    [...f.native.values()].map((value) => value.id),
    ['message02'],
  );
  f.reject('');
  await f.drafts.update('message01', { text: 'edited again' });
  assert.deepEqual(
    [...f.native.values()].map((value) => value.id),
    ['message01', 'message02'],
  );
  assert.equal(
    f.drafts.summaries().some((item) => item.failed),
    false,
  );
  f.drafts.clear();
  assert.equal(f.native.size, 0);
  assert.equal(f.drafts.summaries().length, 0);
});
