import assert from 'node:assert/strict';
import test from 'node:test';
import { A2AAgent } from '@mastra/core/a2a';
import { ORPCError } from '@orpc/server';
import { Hono } from 'hono';
import type {
  GroupChatA2AMember,
  GroupChatMessage,
  GroupChatMessages,
} from '@aime/shared/group-chats';
import {
  groupChatA2aMemberCreateSchema,
  groupChatA2aMemberUpdateSchema,
} from '@aime/shared/group-chats';
import { groupChatA2aRoutes } from './a2a-routes.js';
import { roomMessagesStream } from './a2a-events.js';
import type { GroupChatService } from './service.js';

const roomId = 'room000000000001';
const endpoint = `/api/a2a/rooms/${roomId}`;
const cardPath = `${endpoint}/.well-known/agent-card.json`;
const keyA = 'test-key-a';
const keyB = 'test-key-b';

function fixture() {
  const members = new Map<string, GroupChatA2AMember>(
    [keyA, keyB].map((key, index) => [
      key,
      {
        id: `externalmember0${index}`,
        roomId,
        name: `External ${index}`,
        publicOrigin: null,
        description: '',
        enabled: true,
        keyPrefix: 'test-key',
        createdAt: '2026-10-30T00:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null,
      },
    ]),
  );
  const stored = new Map<string, GroupChatMessage>();
  const reads: { roomId: string; key: string; query: unknown }[] = [];
  const sends: { roomId: string; key: string; input: unknown }[] = [];
  async function authenticateA2a(requestRoom: string, key: string) {
    const member = members.get(key);
    if (
      requestRoom !== roomId ||
      !member ||
      !member.enabled ||
      member.revokedAt
    )
      throw new ORPCError('UNAUTHORIZED');
    return { member, room: { id: roomId, title: 'Room' } };
  }
  let page: GroupChatMessages = { messages: [], hasMore: false, revision: '0' };
  const service = {
    authenticateA2a,
    async sendA2a(
      requestRoom: string,
      key: string,
      input: { id: string; text: string; replyToId?: string },
    ) {
      const { member } = await authenticateA2a(requestRoom, key);
      sends.push({ roomId: requestRoom, key, input });
      const previous = stored.get(input.id);
      if (previous) {
        if (previous.senderId !== member.id || previous.text !== input.text)
          throw new ORPCError('CONFLICT');
        return previous;
      }
      if (input.replyToId && !stored.has(input.replyToId))
        throw new ORPCError('NOT_FOUND');
      const sequence = String(stored.size + 1);
      const message: GroupChatMessage = {
        id: input.id,
        roomId,
        sequence,
        revision: sequence,
        senderId: member.id,
        senderKind: 'a2a',
        senderName: member.name,
        senderUsername: null,
        text: input.text,
        replyToId: input.replyToId ?? null,
        files: [],
        ui: null,
        uiResponse: null,
        targetAgentId: null,
        reactions: [],
        createdAt: '2026-10-30T00:00:00.000Z',
      };
      stored.set(input.id, message);
      return message;
    },
    async messagesA2a(requestRoom: string, key: string, query: unknown) {
      await authenticateA2a(requestRoom, key);
      reads.push({ roomId: requestRoom, key, query });
      return page;
    },
  };
  const app = new Hono().route(
    '/api/a2a/rooms',
    groupChatA2aRoutes(service as unknown as GroupChatService),
  );
  const request = (path: string, init: RequestInit = {}, key = keyA) =>
    app.request(`http://room.test${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    });
  const rpc = (body: unknown, key = keyA, headers?: Record<string, string>) =>
    request(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      key,
    );
  return {
    app,
    request,
    rpc,
    members,
    stored,
    reads,
    sends,
    setPage(value: GroupChatMessages) {
      page = value;
    },
  };
}

function sendRequest(message: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 'request-1',
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'client-message-1',
        parts: [{ kind: 'text', text: 'Hello from outside' }],
        ...message,
      },
    },
  };
}

test('A2A card settings accept HTTP(S) origins and reject credentials or URL paths', () => {
  assert.deepEqual(
    groupChatA2aMemberCreateSchema.parse({
      name: 'External',
      publicOrigin: 'https://room.example:8443/',
      description: '  项目协作室  ',
    }),
    {
      name: 'External',
      publicOrigin: 'https://room.example:8443',
      description: '项目协作室',
    },
  );
  assert.equal(
    groupChatA2aMemberCreateSchema.parse({ name: 'Legacy' }).publicOrigin,
    undefined,
  );
  assert.equal(
    groupChatA2aMemberUpdateSchema.parse({ description: '  ' }).description,
    '',
  );
  for (const publicOrigin of [
    '',
    'not-a-url',
    'https://',
    'javascript:alert(1)',
    'file:///tmp/card',
    'https://user:password@room.example',
    'https://room.example/path',
    'https://room.example?redirect=elsewhere',
    'https://room.example#card',
  ]) {
    assert.equal(
      groupChatA2aMemberCreateSchema.safeParse({
        name: 'External',
        publicOrigin,
      }).success,
      false,
      publicOrigin,
    );
  }
});

test('card discovery and extended cards use saved browser origin and per-key description behind a proxy', async () => {
  const state = fixture();
  const publicOrigin = 'https://room.example:8443';
  const description = '协作处理项目调研和结果核验。';
  Object.assign(state.members.get(keyA)!, { publicOrigin, description });
  const response = await state.request(cardPath);
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.url, `${publicOrigin}${endpoint}`);
  assert.equal(card.description, description);
  const extension = card.capabilities.extensions[0];
  assert.equal(extension.uri, `${publicOrigin}${endpoint}/messages`);
  assert.deepEqual(extension.params, {
    messagesUrl: `${publicOrigin}${endpoint}/messages`,
    eventsUrl: `${publicOrigin}${endpoint}/events`,
    cursor: 'afterRevision',
    contextId: roomId,
  });
  assert.ok(!JSON.stringify(card).includes('http://room.test'));
  const extended = await state.rpc({
    jsonrpc: '2.0',
    id: 'card',
    method: 'agent/getAuthenticatedExtendedCard',
  });
  assert.deepEqual((await extended.json()).result, card);
  const otherCard = await (await state.request(cardPath, {}, keyB)).json();
  assert.notEqual(otherCard.description, description);
  assert.equal(otherCard.url, `http://room.test${endpoint}`);
  state.members.get(keyA)!.description = '';
  assert.equal(
    (await (await state.request(cardPath)).json()).description,
    otherCard.description,
  );
});

test('legacy cards use the incoming request origin, not Origin or forwarded headers', async () => {
  const state = fixture();
  const response = await state.app.request(
    `https://public.example${cardPath}`,
    {
      headers: {
        Authorization: `Bearer ${keyA}`,
        Origin: 'https://unrelated.example',
        'X-Forwarded-Host': '192.168.10.7:8088',
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).url,
    `https://public.example${endpoint}`,
  );
});

test('A2A card, message history, and feeds require their own room-scoped Bearer identity', async () => {
  const state = fixture();
  for (const path of [cardPath, `${endpoint}/messages`, `${endpoint}/events`]) {
    const missing = await state.app.request(path, {
      headers: { Cookie: 'session=human-session' },
    });
    assert.equal(missing.status, 401, path);
    const invalid = await state.request(path, {}, 'invalid-key');
    assert.equal(invalid.status, 401, path);
  }
  const otherRoom = await state.request(
    '/api/a2a/rooms/other00000000001/.well-known/agent-card.json',
  );
  assert.equal(otherRoom.status, 401);
  const response = await state.request(cardPath);
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.protocolVersion, '0.3.0');
  assert.equal(card.url, `http://room.test${endpoint}`);
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.ok(
    Object.values(card.securitySchemes).some(
      (scheme: unknown) =>
        (scheme as { type: string; scheme: string }).type === 'http' &&
        (scheme as { type: string; scheme: string }).scheme === 'bearer',
    ),
  );
  assert.ok(!JSON.stringify(card).includes(keyA));
});

test('A2A publishing derives distinct member identities and retry IDs from the credential', async () => {
  const state = fixture();
  const body = sendRequest({
    senderId: 'owner',
    metadata: { senderId: 'owner', senderKind: 'user' },
  });
  const firstResponse = await state.rpc(body);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.jsonrpc, '2.0');
  assert.equal(first.id, body.id);
  assert.equal(first.result.kind, 'message');
  assert.equal(first.result.role, 'agent');
  assert.equal(first.result.contextId, roomId);
  assert.equal(first.result.metadata.senderId, state.members.get(keyA)!.id);
  const retry = await (await state.rpc(body)).json();
  assert.equal(
    retry.result.metadata.roomMessageId,
    first.result.metadata.roomMessageId,
  );
  assert.equal(state.stored.size, 1);
  const second = await (await state.rpc(body, keyB)).json();
  assert.notEqual(
    first.result.metadata.roomMessageId,
    second.result.metadata.roomMessageId,
  );
  assert.equal(second.result.metadata.senderId, state.members.get(keyB)!.id);
  assert.equal(state.stored.size, 2);
  for (const message of state.stored.values()) {
    assert.match(message.id, /^[a-zA-Z0-9_-]{16,32}$/);
    assert.equal(message.senderKind, 'a2a');
    assert.notEqual(message.senderId, 'owner');
  }
  state.members.get(keyA)!.enabled = false;
  assert.equal((await state.rpc(sendRequest())).status, 401);
  assert.equal(state.stored.size, 2);
});

test('A2A rejects malformed messages, foreign contexts, unsupported content, and protocol versions before publishing', async () => {
  const state = fixture();
  const malformed = await state.request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal((await malformed.json()).error.code, -32700);
  const cases: [unknown, number][] = [
    [[], -32600],
    [{ ...sendRequest(), jsonrpc: '1.0' }, -32600],
    [{ ...sendRequest(), method: 'unknown' }, -32601],
    [sendRequest({ messageId: '' }), -32602],
    [sendRequest({ parts: [] }), -32602],
    [sendRequest({ contextId: 'other-room' }), -32602],
    [sendRequest({ taskId: 'foreign-task' }), -32001],
    [
      sendRequest({
        parts: [
          { kind: 'text', text: 'Do not partially publish this' },
          { kind: 'file', file: { uri: 'https://example.com/file.txt' } },
        ],
      }),
      -32005,
    ],
  ];
  for (const [body, code] of cases) {
    const response = await state.rpc(body);
    const payload = await response.json();
    assert.equal(payload.error?.code, code, JSON.stringify(body));
    assert.equal(payload.jsonrpc, '2.0');
  }
  const version = await state.rpc(sendRequest(), keyA, {
    'A2A-Version': '1.0',
  });
  const versionError = await version.json();
  assert.equal(versionError.error.code, -32009);
  assert.equal(versionError.id, 'request-1');
  assert.equal(state.sends.length, 0);
});

test('a missing reply target returns an invalid-parameters error without treating the credential as revoked', async () => {
  const state = fixture();
  const response = await state.rpc(
    sendRequest({ metadata: { replyToId: 'missingmessage0001' } }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.jsonrpc, '2.0');
  assert.equal(payload.id, 'request-1');
  assert.equal(payload.error.code, -32602);
  assert.equal(state.stored.size, 0);
  assert.equal((await state.request(cardPath)).status, 200);
});

test('room history validates its cursors and keeps the authenticated credential', async () => {
  const state = fixture();
  const history = await state.request(`${endpoint}/messages?after=0&limit=25`);
  assert.equal(history.status, 200);
  assert.deepEqual(await history.json(), {
    messages: [],
    hasMore: false,
    revision: '0',
  });
  assert.deepEqual(state.reads, [
    { roomId, key: keyA, query: { after: '0', limit: 25 } },
  ]);
  for (const query of [
    'before=1&after=2',
    'after=-1',
    'after=9223372036854775808',
    'limit=101',
    'limit=0',
  ]) {
    assert.equal(
      (await state.request(`${endpoint}/messages?${query}`)).status,
      400,
      query,
    );
  }
  assert.equal(state.reads.length, 1);
});

test(
  'room SSE publishes resumable revision cursors and closes when its client aborts',
  { timeout: 3_000 },
  async () => {
    const state = fixture();
    state.setPage({ messages: [], hasMore: false, revision: '9' });
    for (const [query, headers, expected] of [
      ['?afterRevision=7', { 'Last-Event-ID': '3' }, '7'],
      ['', { 'Last-Event-ID': '8' }, '8'],
    ] as const) {
      const controller = new AbortController();
      const response = await state.request(`${endpoint}/events${query}`, {
        headers,
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get('Content-Type') ?? '',
        /^text\/event-stream/,
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let frames = '';
      try {
        while (!frames.includes('event: messages')) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          frames += decoder.decode(chunk.value, { stream: true });
        }
        assert.match(frames, /id: 9\n/);
        assert.match(
          frames,
          /data: \{"messages":\[\],"hasMore":false,"revision":"9"\}/,
        );
        assert.equal(
          (state.reads.at(-1)!.query as { afterRevision: string })
            .afterRevision,
          expected,
        );
      } finally {
        controller.abort();
        await reader.cancel();
      }
    }
    for (const query of [
      'afterRevision=-1',
      'afterRevision=9223372036854775808',
    ])
      assert.equal(
        (await state.request(`${endpoint}/events?${query}`)).status,
        400,
      );
  },
);

test('installed Mastra A2AAgent discovers and publishes through both standard transports', async () => {
  const state = fixture();
  const requests: { method: string; path: string }[] = [];
  const agent = new A2AAgent({
    url: `http://room.test${cardPath}`,
    headers: { Authorization: `Bearer ${keyA}` },
    retries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return state.app.request(request);
    },
  });
  const card = await agent.getAgentCard();
  assert.equal(card.protocolVersion, '0.3.0');
  const result = await agent.generate('SDK sends a room message');
  assert.equal(result.finishReason, 'stop');
  assert.ok(result.text.length > 0);
  assert.equal(result.task, undefined);
  const streaming = await agent.stream('SDK streams a receipt');
  const chunks: string[] = [];
  for await (const chunk of streaming.fullStream) chunks.push(chunk.type);
  const streamed = await streaming.getResult();
  assert.equal(streamed.finishReason, 'stop');
  assert.ok(streamed.text.length > 0);
  assert.ok(chunks.includes('text-delta'));
  assert.equal(state.stored.size, 2);
  assert.deepEqual(
    [...state.stored.values()].map((message) => message.text),
    ['SDK sends a room message', 'SDK streams a receipt'],
  );
  assert.deepEqual(requests, [
    { method: 'GET', path: cardPath },
    { method: 'POST', path: endpoint },
    { method: 'POST', path: endpoint },
  ]);
});

test('SSE reauthorizes catch-up reads and closes with a revoked event before delivering another page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const cursors: string[] = [];
  const response = roomMessagesStream(
    controller.signal,
    async (cursor) => {
      cursors.push(cursor);
      if (cursors.length === 1)
        return { messages: [], hasMore: true, revision: '12' };
      throw new ORPCError('UNAUTHORIZED');
    },
    '7',
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    assert.match(decoder.decode((await reader.read()).value), /: connected/);
    assert.match(decoder.decode((await reader.read()).value), /id: 12/);
    t.mock.timers.tick(0);
    assert.equal(
      decoder.decode((await reader.read()).value),
      'event: revoked\ndata: {}\n\n',
    );
    assert.equal((await reader.read()).done, true);
    t.mock.timers.tick(10_000);
    assert.deepEqual(cursors, ['7', '12']);
  } finally {
    controller.abort();
    await reader.cancel();
  }
});

test('SSE abort discards an in-flight page and never schedules another read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let complete!: (page: GroupChatMessages) => void;
  let reads = 0;
  const response = roomMessagesStream(
    controller.signal,
    () => {
      reads += 1;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    '0',
  );
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  complete({ messages: [], hasMore: true, revision: '10' });
  assert.equal((await reader.read()).done, true);
  t.mock.timers.tick(10_000);
  assert.equal(reads, 1);
  await reader.cancel();
});
