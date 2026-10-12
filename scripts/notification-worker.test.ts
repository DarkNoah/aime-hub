import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(
  new URL('../apps/web/public/notification-sw.js', import.meta.url),
  'utf8',
);
const id = 'a'.repeat(64);
function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: {
    title: string;
    options: { tag: string; data: { url: string } };
  }[] = [];
  const opened: string[] = [];
  const requests: string[] = [];
  const notification = {
    id,
    taskName: 'Daily summary',
    status: 'succeeded',
    url: '/automations',
    createdAt: new Date().toISOString(),
  };
  const response = { ok: true, userId: 'alice', notification };
  const self = {
    addEventListener(name: string, callback: (event: unknown) => void) {
      handlers.set(name, callback);
    },
    location: { origin: 'https://app.example.test' },
    registration: {
      async showNotification(
        title: string,
        options: (typeof shown)[number]['options'],
      ) {
        shown.push({ title, options });
      },
    },
    clients: {
      async matchAll() {
        return [] as {
          url: string;
          navigate: (url: string) => Promise<void>;
          focus: () => Promise<void>;
        }[];
      },
      async openWindow(url: string) {
        opened.push(url);
      },
    },
  };
  runInNewContext(source, {
    self,
    URL,
    Date,
    fetch: async (url: string) => {
      requests.push(url);
      return { ok: response.ok, json: async () => response };
    },
  });
  const dispatch = async (name: string, data: object) => {
    let pending: Promise<void> | undefined;
    handlers.get(name)!({
      ...data,
      waitUntil(promise: Promise<void>) {
        pending = promise;
      },
    });
    await pending;
  };
  return { response, shown, opened, requests, self, dispatch };
}

test('closed-page worker fetches authorized notification and displays localized success/failure', async () => {
  const w = worker();
  const push = {
    data: { json: () => ({ id, userId: 'alice', locale: 'zh-CN' }) },
  };
  await w.dispatch('push', push);
  assert.equal(w.shown[0].title, '自动化已完成');
  assert.equal(w.shown[0].options.tag, id);
  assert.equal(w.requests[0], `/api/notifications/${id}`);
  w.response.notification.status = 'failed';
  await w.dispatch('push', push);
  assert.equal(w.shown[1].title, '自动化执行失败');
});

test('worker never displays an old account notification or revoked project result', async () => {
  const w = worker();
  const push = { data: { json: () => ({ id, userId: 'alice' }) } };
  w.response.userId = 'bob';
  await w.dispatch('push', push);
  w.response.userId = 'alice';
  w.response.ok = false;
  await w.dispatch('push', push);
  w.response.ok = true;
  w.response.notification.url = 'https://evil.test';
  await w.dispatch('push', push);
  await w.dispatch('push', {
    data: { json: () => ({ id: '../../secret', userId: 'alice' }) },
  });
  assert.equal(w.shown.length, 0);
  assert.equal(w.requests.length, 3);
});

test('notification click opens or reuses a same-origin page and rejects external navigation', async () => {
  const w = worker();
  let closed = 0;
  const click = {
    notification: {
      close() {
        closed++;
      },
      data: { url: 'https://app.example.test/automations' },
    },
  };
  await w.dispatch('notificationclick', click);
  assert.deepEqual(w.opened, [click.notification.data.url]);
  let focused = 0;
  const navigated: string[] = [];
  w.self.clients.matchAll = async () => [
    {
      url: 'https://app.example.test/threads',
      navigate: async (url) => {
        navigated.push(url);
      },
      focus: async () => {
        focused++;
      },
    },
  ];
  await w.dispatch('notificationclick', click);
  assert.equal(focused, 1);
  assert.deepEqual(navigated, [click.notification.data.url]);
  click.notification.data.url = 'https://evil.test';
  await w.dispatch('notificationclick', click);
  assert.equal(w.opened.length, 1);
  assert.equal(closed, 3);
});
