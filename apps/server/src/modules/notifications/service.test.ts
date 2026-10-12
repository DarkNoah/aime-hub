import assert from 'node:assert/strict';
import test from 'node:test';
import type { Automation } from '@aime/shared/automations';
import type { NotificationEvent } from '@aime/shared/notifications';
import { pushSubscriptionSchema } from '@aime/shared/notifications';
import { NotificationService } from './service.js';
import type {
  NotificationStore,
  NotificationRecord,
  PushRecipient,
} from './store.js';
import {
  fixture,
  input,
  personal,
  until,
} from '../automations/test-fixture.js';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';

function storeFixture() {
  const records: NotificationRecord[] = [];
  const recipients: PushRecipient[] = [
    {
      endpoint: 'https://fcm.googleapis.com/test',
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
      locale: 'zh-CN',
      userId: 'alice',
      sessionId: 'session',
    },
  ];
  const removed: string[] = [];
  const store: NotificationStore = {
    async put(record) {
      if (
        records.some((item) => item.notification.id === record.notification.id)
      )
        return false;
      records.push(record);
      return true;
    },
    async read(userId, after) {
      return {
        items:
          after === undefined
            ? []
            : records.flatMap((item, index) =>
                item.ownerId === userId && index + 1 > Number(after)
                  ? [
                      {
                        cursor: String(index + 1),
                        notification: item.notification,
                      },
                    ]
                  : [],
              ),
        cursor: String(records.length),
        more: false,
      };
    },
    async get(userId, id) {
      return records.find(
        (item) => item.ownerId === userId && item.notification.id === id,
      )?.notification;
    },
    async subscribe() {},
    async unsubscribe() {},
    async recipients() {
      return recipients;
    },
    async removeExpired(endpoint) {
      removed.push(endpoint);
    },
  };
  return { store, records, recipients, removed };
}

test('page notifications always deliver, desktop flag gates push, terminal callbacks deduplicate and reconnect replays', async (t) => {
  const { store, records } = storeFixture();
  const sent: string[] = [];
  const notifications = new NotificationService(store, {
    publicKey: 'public',
    async send(_recipient, id) {
      sent.push(id);
    },
  });
  t.after(() => notifications.close());
  const events: NotificationEvent[] = [];
  const stop = notifications.subscribe(
    'alice',
    undefined,
    (event) => events.push(event),
    () => {},
    async () => true,
  );
  await notifications.settled();
  const { service } = await fixture(t);
  const task = await service.create('alice', personal, input);
  await notifications.publish(task, 'succeeded', 'run-1');
  await notifications.publish(task, 'succeeded', 'run-1');
  await notifications.settled();
  assert.equal(records.length, 1);
  assert.equal(events.filter((item) => item.type === 'notification').length, 1);
  assert.equal(records[0].notification.url, '/automations');
  assert.deepEqual(sent, []);
  stop();
  await notifications.publish(
    {
      ...task,
      desktopNotification: true,
      separateThread: true,
      threadCreated: true,
    },
    'failed',
    'run-2',
  );
  await notifications.settled();
  assert.equal(sent.length, 1);
  assert.equal(
    records[1].notification.url,
    `/threads/${encodeURIComponent(task.threadId)}`,
  );
  const replay: NotificationEvent[] = [];
  notifications.subscribe(
    'alice',
    '1',
    (event) => replay.push(event),
    () => {},
    async () => true,
  );
  await notifications.settled();
  assert.deepEqual(
    replay
      .filter((event) => event.type === 'notification')
      .map((event) => event.notification.status),
    ['failed'],
  );
});

test('push failure does not affect a persisted result and expired endpoints are removed', async (t) => {
  const { store, removed, records } = storeFixture();
  const notifications = new NotificationService(store, {
    publicKey: 'public',
    async send() {
      throw { statusCode: 410 };
    },
  });
  const { service } = await fixture(t);
  const task = await service.create('alice', personal, {
    ...input,
    desktopNotification: true,
  });
  await notifications.publish(task, 'failed', 'run');
  await notifications.settled();
  assert.equal(records.length, 1);
  assert.deepEqual(removed, ['https://fcm.googleapis.com/test']);
  let closed = 0;
  notifications.subscribe(
    'alice',
    '0',
    () => assert.fail('Expired sessions cannot receive events'),
    () => closed++,
    async () => false,
  );
  await notifications.settled();
  assert.equal(closed, 1);
  await notifications.close();
});

test('actual native schedule emits completion and preparation/model failures, never merely accepted work', async (t) => {
  const received: { task: Automation; status: string; id: string }[] = [];
  const notifications = {
    async publish(
      task: Automation,
      status: 'succeeded' | 'failed',
      id: string,
    ) {
      received.push({ task, status, id });
    },
  };
  const run = await fixture(t, { notifications });
  const task = await run.service.create('alice', personal, input);
  await run.mastra.schedules.run(task.id);
  await until(
    async () => received,
    (items) => items.some((item) => item.task.id === task.id),
  );
  assert.ok(received.every((item) => item.status === 'succeeded'));
  assert.equal(received[0].task.desktopNotification, false);
  assert.equal(received[0].task.threadCreated, true);
  const invalid = await run.service.create('alice', personal, input);
  run.users.get('alice')!.banned = true;
  await run.mastra.schedules.run(invalid.id).catch(() => {});
  await until(
    async () => received,
    (items) =>
      items.some(
        (item) => item.task.id === invalid.id && item.status === 'failed',
      ),
  );
  const model = createMockModel({ version: 'v2', mockText: 'unused' });
  t.mock.method(model, 'doStream', async () => {
    throw new Error('model failed');
  });
  const broken = await fixture(t, { notifications, model });
  const failing = await broken.service.create('alice', personal, input);
  await broken.mastra.schedules.run(failing.id).catch(() => {});
  await until(
    async () => received,
    (items) =>
      items.some(
        (item) => item.task.id === failing.id && item.status === 'failed',
      ),
  );
});

test('subscriptions accept browser push services only and reject arbitrary server request targets', () => {
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/test',
    keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
    locale: 'en',
  };
  for (const endpoint of [
    'https://fcm.googleapis.com/test',
    'https://updates.push.services.mozilla.com/test',
    'https://web.push.apple.com/test',
    'https://wns2-db5p.notify.windows.com/test',
  ]) {
    assert.equal(
      pushSubscriptionSchema.safeParse({ ...subscription, endpoint }).success,
      true,
      endpoint,
    );
  }
  for (const endpoint of [
    'https://127.0.0.1/test',
    'http://fcm.googleapis.com/test',
    'https://fcm.googleapis.com.evil.test/test',
    'https://user:secret@fcm.googleapis.com/test',
    'https://fcm.googleapis.com:444/test',
    'not-a-url',
  ]) {
    assert.equal(
      pushSubscriptionSchema.safeParse({ ...subscription, endpoint }).success,
      false,
      endpoint,
    );
  }
});
