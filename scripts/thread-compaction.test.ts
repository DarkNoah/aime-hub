import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../apps/server/src/app.js';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import type { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { sessionStub } from './fixtures/thread-session.js';
import {
  consumeCompactCommand,
  filterCommandGroups,
} from '../apps/web/src/components/chat/slash-command.js';
import { getMessageCompressions } from '../apps/web/src/components/chat/message-compression.js';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const origin = 'http://localhost:5173';
const base = {
  async validate() {},
  async createWorkspace() {
    return '/unused';
  },
};

test('compact command is local, searchable and preserves the remaining draft', () => {
  assert.equal(consumeCompactCommand('/compact'), '');
  assert.equal(consumeCompactCommand('/COMPACT\nkeep draft'), 'keep draft');
  for (const value of ['/compaction', '/compact/file', 'Explain /compact'])
    assert.equal(consumeCompactCommand(value), null);
  const groups = [
    {
      id: 'actions',
      label: '会话操作',
      sections: [
        {
          id: 'actions',
          items: [
            {
              id: 'command:compact',
              name: 'compact',
              action: 'compact' as const,
              description: '立即压缩消息',
            },
          ],
        },
      ],
    },
  ];
  assert.equal(
    filterCommandGroups(groups, '压缩')[0].sections[0].items[0].action,
    'compact',
  );
});

test('failed compaction replaces its running marker, including replayed starts', () => {
  const start = {
    type: 'data-om-observation-start' as const,
    data: { cycleId: 'cycle' },
  };
  const failed = {
    type: 'data-om-observation-failed' as const,
    data: { cycleId: 'cycle' },
  };
  const result = getMessageCompressions([
    { id: 'message', role: 'assistant', parts: [start, failed, start] },
  ]);
  assert.equal(result.size, 1);
  assert.equal(result.get(failed)?.status, 'failed');
});

test('compaction API enforces session, origin, scope and validation without sending a prompt', async (t) => {
  const { memory } = fakeMemory();
  const targets: string[] = [];
  let sends = 0;
  let member = true;
  const service = new ThreadService(
    memory,
    {
      ...base,
      async open({ thread }) {
        return sessionStub({
          async compact() {
            targets.push(thread.resourceId!);
            return { observed: true };
          },
          async send() {
            sends++;
          },
        });
      },
    },
    {
      async assertMember(userId) {
        if (userId !== 'alice' || !member)
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: 'owner' as const };
      },
    },
  );
  t.after(() => service.shutdown());
  const personal = await service.createThread('alice', settings);
  const projectId = 'project123456789';
  const shared = await service.createThread('alice', {
    ...settings,
    projectId,
  });
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const id = headers.get('x-test-user');
        return id ? { user: { id, role: 'user' } } : null;
      },
    },
  } as unknown as Parameters<typeof createApp>[0];
  const app = createApp(auth, undefined, {
    threads: service,
    models: {} as LanguageModelService,
    webOrigin: origin,
  });
  const request = (id: string, user = 'alice', requestOrigin = origin) =>
    app.request(`/api/threads/${id}/compact`, {
      method: 'POST',
      headers: { origin: requestOrigin, 'x-test-user': user },
    });
  assert.equal((await request(personal.id, '')).status, 401);
  assert.equal(
    (await request(personal.id, 'alice', 'https://other.example')).status,
    403,
  );
  assert.equal((await request('invalid')).status, 400);
  assert.equal((await request(personal.id, 'bob')).status, 404);
  assert.equal((await request(shared.id, 'bob')).status, 404);
  assert.deepEqual(targets, []);
  assert.deepEqual(await (await request(personal.id)).json(), {
    observed: true,
  });
  assert.deepEqual(await (await request(shared.id)).json(), { observed: true });
  assert.deepEqual(targets, ['user:alice', `project:${projectId}`]);
  member = false;
  assert.equal((await request(shared.id)).status, 404);
  assert.equal(sends, 0);
});

test('compaction rejects active/suspended threads and serializes new input until completion', async (t) => {
  const { memory, threads } = fakeMemory();
  let context: Parameters<ChatRunner['open']>[0] | undefined;
  let finish!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const actions: string[] = [];
  const service = new ThreadService(memory, {
    ...base,
    async open(value) {
      context = value;
      return sessionStub({
        async compact() {
          actions.push('compact');
          started();
          await gate;
          actions.push('compacted');
          return { observed: true };
        },
        async send() {
          actions.push('send');
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const suspended = await service.createThread('alice', settings);
  threads.get(suspended.id)!.metadata!.status = 'suspended';
  await assert.rejects(service.compact('alice', suspended.id), {
    code: 'COMPACTION_BUSY',
  });
  const thread = await service.createThread('alice', settings);
  const compacting = service.compact('alice', thread.id);
  await begun;
  const sending = service.run('alice', thread.id, {
    ...settings,
    id: 'message01',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Continue' }],
  });
  assert.deepEqual(actions, ['compact']);
  finish();
  await Promise.all([compacting, sending]);
  assert.deepEqual(actions, ['compact', 'compacted', 'send']);
  context!.onEvent({ type: 'status', status: 'running', runId: 'run' });
  await assert.rejects(service.compact('alice', thread.id), {
    code: 'COMPACTION_BUSY',
  });
  context!.onEvent({ type: 'status', status: 'success', runId: 'run' });
});
