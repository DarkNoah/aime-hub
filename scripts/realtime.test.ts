import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Auth } from '@aime/auth';
import type { RealtimeEvent } from '@aime/shared/realtime';
import { realtimeRoutes } from '../apps/server/src/modules/realtime/routes.js';
import { RealtimeConnection } from '../apps/server/src/modules/realtime/connection.js';
import { eventStream } from '../apps/server/src/modules/threads/event-stream.js';
import { RealtimeBroker } from '../apps/web/src/components/realtime/broker.js';

const origin = 'http://localhost:5173';
const thread = '/api/threads/abcdefghijklmnop/messages?view=summary';
const navigation = '/api/threads/events';
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const user = headers.get('x-test-user') ?? 'alice';
      return { user: { id: user }, session: { id: `${user}-session` } };
    },
  },
} as unknown as Auth;

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('Expected realtime state was not received');
}

function consume(response: Response) {
  const events: { event: string; data: string }[] = [];
  const reader = response.body!.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (event && data) events.push({ event, data });
      }
    }
  })();
  return { events, done, cancel: () => reader.cancel() };
}

test('one SSE routes independent snapshots and updates; adding/removing channels keeps existing feeds alive', async (t) => {
  const feeds = new Map<
    string,
    { send: (event: string, data: unknown) => void; signal: AbortSignal }
  >();
  let opens = 0,
    closes = 0;
  const app = realtimeRoutes(
    auth,
    async (request) => {
      const path = new URL(request.url).pathname;
      opens++;
      return eventStream(
        request.signal,
        (send) => {
          feeds.set(path, { send, signal: request.signal });
          send('snapshot', { path, text: '中文快照' });
          return () => {
            closes++;
            feeds.delete(path);
          };
        },
        async () => undefined,
      );
    },
    [origin],
  );
  const connectionId = randomUUID();
  const url = `/${connectionId}?session=alice-session`;
  const abort = new AbortController();
  const response = await app.request(url, { signal: abort.signal });
  const stream = consume(response);
  t.after(() => {
    abort.abort();
  });
  await until(() => stream.events.some((e) => e.event === 'ready'));
  const { generation } = JSON.parse(
    stream.events.find((e) => e.event === 'ready')!.data,
  );
  const configure = async (
    revision: number,
    subscriptions: { id: string; url: string }[],
  ) => {
    const result = await app.request(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation, revision, subscriptions }),
    });
    assert.equal(result.status, 200);
  };
  const nav = { id: randomUUID(), url: navigation };
  const chat = { id: randomUUID(), url: thread };
  await configure(1, [nav]);
  await until(
    () => stream.events.filter((e) => e.event === 'event').length === 1,
  );
  await configure(2, [nav, chat]);
  await until(
    () => stream.events.filter((e) => e.event === 'event').length === 2,
  );
  assert.equal(opens, 2, 'Adding a chat must not resubscribe navigation');
  const events = () =>
    stream.events
      .filter((e) => e.event === 'event')
      .map((e) => JSON.parse(e.data) as RealtimeEvent);
  assert.deepEqual(
    events().map((e) => e.id),
    [nav.id, chat.id],
  );
  assert.equal(JSON.parse(events()[1].data).text, '中文快照');
  feeds
    .get('/api/threads/abcdefghijklmnop/messages')!
    .send('speech', { sequence: 1, audio: 'chunk' });
  await until(() => events().some((e) => e.event === 'speech'));
  await configure(1, [nav]);
  assert.equal(
    feeds.size,
    2,
    'Stale configuration must not remove a newer subscription',
  );
  await configure(3, [chat]);
  await until(() => closes === 1);
  assert.equal(opens, 2);
  assert.equal(feeds.size, 1);
  abort.abort();
  await stream.done;
  await until(() => closes === 2);
  const missing = await app.request(url, {
    method: 'POST',
    headers: { Origin: origin },
    body: JSON.stringify({ generation, revision: 4, subscriptions: [] }),
  });
  assert.equal(missing.status, 409);
});

test('multiplex controls enforce session ownership, origin, feed allowlist and connection generation', async (t) => {
  const app = realtimeRoutes(
    auth,
    async () => new Response(null, { status: 404 }),
    [origin],
  );
  const id = randomUUID();
  const url = `/${id}?session=alice-session`;
  const stream = consume(await app.request(url));
  t.after(() => stream.cancel());
  await until(() => stream.events.length > 0);
  const { generation } = JSON.parse(stream.events[0].data);
  const body = {
    generation,
    revision: 1,
    subscriptions: [{ id: randomUUID(), url: navigation }],
  };
  const post = (
    value: unknown,
    headers: Record<string, string> = { Origin: origin },
    target = url,
  ) =>
    app.request(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
    });
  assert.equal(
    (await post(body, { Origin: 'https://other.example' })).status,
    403,
  );
  assert.equal(
    (await post(body, { Origin: origin, 'x-test-user': 'bob' })).status,
    401,
  );
  assert.equal(
    (
      await post(
        body,
        { Origin: origin, 'x-test-user': 'bob' },
        `/${id}?session=bob-session`,
      )
    ).status,
    409,
  );
  assert.equal((await app.request(`/${id}?session=old-session`)).status, 401);
  assert.equal((await post({ ...body, generation: randomUUID() })).status, 409);
  for (const url of [
    'https://other.example',
    '/api/admin/users',
    '/api/threads/../events',
    '/api/threads/abcdefghijklmnop/messages?view=full',
  ])
    assert.equal(
      (await post({ ...body, subscriptions: [{ id: randomUUID(), url }] }))
        .status,
      400,
    );
  assert.equal(
    (
      await post({
        ...body,
        subscriptions: [body.subscriptions[0], body.subscriptions[0]],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post({
        ...body,
        subscriptions: [
          {
            id: randomUUID(),
            url: '/api/threads/schedule%3Aabcdefghijklmnop/browser/events',
          },
        ],
      })
    ).status,
    200,
  );
});

test('concurrent reconnects retire the previous connection and reject its configuration', async (t) => {
  const app = realtimeRoutes(auth, async () => new Response(null), [origin]);
  const url = `/${randomUUID()}?session=alice-session`;
  const responses = await Promise.all([app.request(url), app.request(url)]);
  const streams = responses.map(consume);
  t.after(async () => {
    await Promise.all(streams.map((stream) => stream.cancel()));
  });
  await until(() => streams.every((stream) => stream.events.length > 0));
  await streams[0].done;
  const statuses = await Promise.all(
    streams.map(async (stream) => {
      const { generation } = JSON.parse(stream.events[0].data);
      const response = await app.request(url, {
        method: 'POST',
        headers: { Origin: origin },
        body: JSON.stringify({ generation, revision: 1, subscriptions: [] }),
      });
      return response.status;
    }),
  );
  assert.deepEqual(statuses, [409, 200]);
});

test('a revoked channel does not disconnect other chats; network loss cleans up all observers', async () => {
  const messages: RealtimeEvent[] = [];
  let closeHealthy: () => void = () => {},
    cleaned = 0,
    disconnected = 0;
  const connection = new RealtimeConnection(
    async (url, signal) => {
      if (url === 'denied')
        return Response.json({ code: 'THREAD_NOT_FOUND' }, { status: 404 });
      return eventStream(
        signal,
        (send, close) => {
          closeHealthy = close;
          send('snapshot', { ok: true });
          return () => {
            cleaned++;
          };
        },
        async () => undefined,
      );
    },
    async (event) => {
      messages.push(event);
    },
    () => {
      disconnected++;
      connection.close();
    },
  );
  connection.configure({
    generation: connection.generation,
    revision: 1,
    subscriptions: [
      { id: 'denied', url: 'denied' },
      { id: 'healthy', url: 'healthy' },
    ],
  });
  await until(() => messages.length === 2);
  assert.equal(disconnected, 0);
  assert.equal(messages.find((e) => e.id === 'denied')!.event, 'revoked');
  closeHealthy();
  await until(() => cleaned === 1 && disconnected > 0);
});

test('late feed creation is cancelled when its subscriber leaves', async () => {
  let finish: ((response: Response) => void) | undefined;
  let cancelled = false;
  const connection = new RealtimeConnection(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    async () => {
      assert.fail('Late data must not be delivered');
    },
    () => {},
  );
  connection.configure({
    generation: connection.generation,
    revision: 1,
    subscriptions: [{ id: 'late', url: 'late' }],
  });
  connection.close();
  finish!(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await until(() => cancelled);
});

test('broker shares one EventSource across peers and restores subscriptions after reconnect', async (t) => {
  const sources: FakeSource[] = [];
  class FakeSource extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      super();
      sources.push(this);
    }
    close() {
      this.readyState = 2;
    }
    ready(generation: string) {
      this.dispatchEvent(
        new MessageEvent('ready', { data: JSON.stringify({ generation }) }),
      );
    }
  }
  const requests: {
    generation: string;
    subscriptions: { id: string; url: string }[];
  }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (...[, init]: Parameters<typeof fetch>) => {
      requests.push(JSON.parse(init!.body as string));
      return Response.json({ ok: true });
    },
  );
  const original = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: FakeSource });
  t.after(() => {
    Object.assign(globalThis, { EventSource: original });
  });
  const broker = new RealtimeBroker('alice-session');
  t.after(() => broker.close());
  const alice: RealtimeEvent[] = [],
    bob: RealtimeEvent[] = [];
  const a = [{ id: 'a', url: navigation }],
    b = [{ id: 'b', url: thread }];
  broker.update('alice', a, (event) => alice.push(event));
  broker.update('bob', b, (event) => bob.push(event));
  assert.equal(sources.length, 1);
  sources[0].ready('first');
  await until(() => requests.length === 1);
  assert.equal(requests[0].subscriptions.length, 2);
  sources[0].dispatchEvent(
    new MessageEvent('event', {
      data: JSON.stringify({
        id: 'b',
        event: 'snapshot',
        data: '{"chat":"b"}',
      }),
    }),
  );
  assert.equal(alice.length, 0);
  assert.equal(bob.length, 1);
  broker.update('bob', b, (event) => bob.push(event));
  await delay(10);
  assert.equal(
    requests.length,
    1,
    'Presence heartbeats must not reconfigure feeds',
  );
  sources[0].onerror?.();
  assert.equal(alice[0].event, 'error');
  sources[0].ready('second');
  await until(() => requests.length === 2);
  assert.equal(requests[1].generation, 'second');
  assert.equal(sources.length, 1);
  broker.remove('alice');
  await until(() => requests.length === 3);
  assert.deepEqual(requests[2].subscriptions, b);
  assert.equal(sources[0].readyState, 1);
  broker.remove('bob');
  assert.equal(sources[0].readyState, 2);
});
