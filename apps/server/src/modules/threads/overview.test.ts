import assert from 'node:assert/strict';
import test from 'node:test';
import { Memory } from '@mastra/memory';
import { InMemoryStore } from '@mastra/core/storage';
import { convertMessages } from '@mastra/core/agent';
import { isToolUIPart, type UIMessage } from 'ai';
import { isChatToolGroupPart } from '@aime/shared/chat-turns';
import { ThreadService } from './service.js';
import { createApp } from '../../app.js';

async function fixture() {
  const storage = new InMemoryStore();
  const memory = new Memory({ storage, options: { generateTitle: false, semanticRecall: false } });
  const service = new ThreadService(memory, {
    async validate() {},
    async createWorkspace() { return '/tmp/thread-overview'; },
    async open() { throw new Error('Reading an overview must not start an agent'); },
  });
  const thread = await service.createThread('alice', { model: null, reasoningEffort: 'auto' });
  const store = (await storage.getStore('memory'))!;
  async function save(messages: UIMessage[]) {
    await store.saveMessages({ messages: messages.flatMap((message, index) =>
      convertMessages([message]).to('Mastra.V2').map((raw) => ({
        ...raw, threadId: thread.id, resourceId: 'user:alice',
        createdAt: new Date(1_700_000_000_000 + index),
        content: JSON.parse(JSON.stringify(raw.content)),
      })),
    ) });
  }
  let userId: string | undefined = 'alice';
  const auth = { api: { getSession: async () => userId ? { user: { id: userId, role: 'user' } } : null } } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, { threads: service, models: {} as never, webOrigin: 'http://localhost:5173' });
  return { service, thread, save, app, setUser: (id?: string) => { userId = id; } };
}

const user = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: `Question ${id}` }] });
const tool = (id: string, output: unknown = { text: id }): UIMessage['parts'][number] => ({
  type: 'tool-read_file', toolCallId: id, state: 'output-available', input: { path: `${id}.txt` }, output,
});

test('public overview omits a 70 MiB tool result, keeps all text and matches summary SSE', async (t) => {
  const f = await fixture();
  t.after(() => f.service.shutdown());
  await f.save([user('u1'), { id: 'assistant', role: 'assistant', parts: [
    { type: 'text', text: 'Before tools' },
    tool('large', { text: 'x'.repeat(70 * 1024 * 1024) }),
    tool('small'),
    { type: 'text', text: 'Between tools' },
    tool('last'),
    { type: 'text', text: 'Final answer' },
  ] }]);
  const response = await f.app.request(`/api/threads/${f.thread.id}`);
  assert.equal(response.status, 200);
  const json = await response.text();
  assert.ok(Buffer.byteLength(json) < 10_000, `Overview unexpectedly contains ${Buffer.byteLength(json)} bytes`);
  const snapshot = JSON.parse(json) as Awaited<ReturnType<ThreadService['getThreadOverview']>>;
  assert.equal('messages' in snapshot, false);
  assert.deepEqual(snapshot.turns[0].assistant!.parts.filter((p) => p.type === 'text').map((p) => p.text), ['Before tools', 'Between tools', 'Final answer']);
  const groups = snapshot.turns[0].assistant!.parts.filter(isChatToolGroupPart);
  assert.deepEqual(groups.map((g) => g.data.count), [2, 1]);
  const unsubscribe = await f.service.subscribe('alice', f.thread.id, () => {}, undefined, undefined, (stream) => {
    assert.deepEqual(stream.turns, snapshot.turns);
  });
  unsubscribe();
  // Opening a small group must never return another group's huge payload.
  const detail = await f.service.toolGroupDetail('alice', f.thread.id, 'u1', groups[1].data.id);
  assert.deepEqual(detail.messages.flatMap((m) => m.parts).filter(isToolUIPart).map((p) => p.toolCallId), ['last']);
  assert.ok(JSON.stringify(detail).length < 2_000);
  t.diagnostic(`70 MiB tool payload -> ${Buffer.byteLength(json)} byte overview`);
});

test('tool groups page within a single assistant message and retain authorization', async (t) => {
  const f = await fixture();
  t.after(() => f.service.shutdown());
  await f.save([user('u1'), { id: 'a1', role: 'assistant', parts: Array.from({ length: 45 }, (_, i) => tool(`call-${i}`)) }]);
  const overview = await f.service.getThreadOverview('alice', f.thread.id);
  const group = overview.turns[0].assistant!.parts.find(isChatToolGroupPart)!.data;
  const pages = await Promise.all([0, 1, 2].map((page) => f.service.toolGroupDetail('alice', f.thread.id, 'u1', group.id, undefined, page)));
  assert.deepEqual(pages.map((p) => p.messages.flatMap((m) => m.parts).length), [20, 20, 5]);
  assert.deepEqual(pages.map((p) => p.hasMore), [true, true, false]);
  assert.equal(new Set(pages.flatMap((p) => p.messages.flatMap((m) => m.parts).filter(isToolUIPart).map((p) => p.toolCallId))).size, 45);
  await assert.rejects(f.service.toolGroupDetail('bob', f.thread.id, 'u1', group.id), /THREAD_NOT_FOUND/);
  await assert.rejects(f.service.toolGroupDetail('alice', f.thread.id, 'u1', 'other'), /TOOL_GROUP_NOT_FOUND/);
  await assert.rejects(f.service.toolGroupDetail('alice', f.thread.id, 'u1', group.id, undefined, -1), /VALIDATION_ERROR/);
  const response = await f.app.request(`/api/threads/${f.thread.id}/turns/u1/groups/${encodeURIComponent(group.id)}?page=1`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).page, 1);
});

test('overview pages preserve every user and intermediate text across more than 20 turns', async (t) => {
  const f = await fixture();
  t.after(() => f.service.shutdown());
  await f.save(Array.from({ length: 25 }, (_, i) => [user(`u${i}`), { id: `a${i}`, role: 'assistant', parts: [{ type: 'text', text: `start ${i}` }, tool(`call-${i}`), { type: 'text', text: `end ${i}` }] } as UIMessage]).flat());
  const latest = await f.service.getThreadOverview('alice', f.thread.id);
  assert.equal(latest.turns.length, 20);
  assert.ok(latest.history?.cursor);
  const earlier = await f.service.turnHistory('alice', f.thread.id, latest.history.cursor);
  const all = [...earlier.turns, ...latest.turns];
  assert.equal(all.length, 25);
  assert.deepEqual(all.map((turn) => turn.user!.id), Array.from({ length: 25 }, (_, i) => `u${i}`));
  assert.equal(all.flatMap((turn) => turn.assistant!.parts.filter((p) => p.type === 'text')).length, 50);
  assert.equal(earlier.hasMore, false);
});

test('legacy user and generated media use authorized URLs, including range requests', async (t) => {
  const f = await fixture();
  t.after(() => f.service.shutdown());
  const bytes = Buffer.from('legacy-image-bytes');
  await f.save([
    { ...user('u1'), parts: [...user('u1').parts, { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${bytes.toString('base64')}` }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'tool-image_gen', toolCallId: 'generated', state: 'output-available', input: { ref_images: [`data:image/png;base64,${bytes.toString('base64')}`] }, output: { content: [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] } }] },
  ]);
  const overview = await f.service.getThreadOverview('alice', f.thread.id);
  assert.equal(JSON.stringify(overview).includes(bytes.toString('base64')), false);
  const file = overview.turns[0].user!.parts.find((p) => p.type === 'file')!;
  const response = await f.app.request(file.url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-security-policy')!, /sandbox/);
  const ranged = await f.app.request(file.url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(2, 6));
  assert.equal((await f.app.request(file.url, { headers: { Range: 'bytes=999-' } })).status, 416);
  const generated = overview.turns[0].assistant!.parts.find(isToolUIPart)!;
  const output = generated.output as { content: { url: string }[] };
  assert.deepEqual(Buffer.from(await (await f.app.request(output.content[0].url)).arrayBuffer()), bytes);
  f.setUser('bob');
  assert.equal((await f.app.request(file.url)).status, 404);
  f.setUser();
  assert.equal((await f.app.request(file.url)).status, 401);
});
