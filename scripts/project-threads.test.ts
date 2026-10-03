import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { requireMemberChange } from '../apps/server/src/modules/projects/permissions.js';
import {
  createProjectWorkspace,
  discoverProjectSkills,
  getWorkspace,
  projectDirectory,
} from '../apps/server/src/modules/threads/workspace.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import type { ProjectRole } from '@aime/shared/projects';
import {
  createThreadSchema,
  type RunInput,
  type ThreadSnapshot,
} from '@aime/shared/threads';
import type { UIMessage } from 'ai';

const projectId = 'project123456789';
const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = (id: string): RunInput => ({
  ...settings,
  id,
  parts: [{ type: 'text', text: id }],
  isImmediate: false,
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error('Expected state was not reached');
}
function projectAccess() {
  const members = new Map<string, ProjectRole>([
    ['alice', 'owner'],
    ['bob', 'member'],
    ['carol', 'admin'],
  ]);
  return {
    members,
    async assertMember(userId: string, id: string) {
      const role = id === projectId ? members.get(userId) : undefined;
      if (!role) throw new ThreadError('PROJECT_NOT_FOUND', 404);
      return { role };
    },
  };
}
const runner = {
  async validate() {},
  async createWorkspace(_userId: string, id?: string) {
    return id ? `/workspace/projects/${id}` : '/workspace/users/alice/test';
  },
  async execute() {},
};

test('project role changes reject owner removal and admin privilege escalation', () => {
  for (const operation of [
    () => requireMemberChange('owner', 'owner'),
    () => requireMemberChange('admin', 'admin'),
    () => requireMemberChange('admin', 'member', 'admin'),
    () => requireMemberChange('member', 'member'),
  ])
    assert.throws(operation, ThreadError);
  requireMemberChange('owner', 'member', 'admin');
  requireMemberChange('admin', 'member');
  assert.equal(
    createThreadSchema.safeParse({ projectId, resourceId: 'user:bob' }).success,
    false,
  );
});

test('project thread access covers all commands, preserves personal isolation and uses project resource for history', async (t) => {
  const { memory } = fakeMemory();
  const access = projectAccess();
  const service = new ThreadService(memory, runner, access);
  t.after(() => service.shutdown());
  const shared = await service.createThread('alice', {
    ...settings,
    projectId,
  });
  const personal = await service.createThread('alice', settings);
  assert.equal(shared.projectId, projectId);
  assert.equal(
    (await service.getThread('bob', shared.id)).thread.id,
    shared.id,
  );
  assert.deepEqual(
    (await service.listThreads('alice')).threads.map((thread) => thread.id),
    [personal.id],
  );
  assert.deepEqual(
    (await service.listThreads('bob', 0, projectId)).threads.map(
      (thread) => thread.id,
    ),
    [shared.id],
  );
  let recalledResource = '';
  const recall = memory.recall;
  memory.recall = async (args) => {
    recalledResource = args.resourceId!;
    return recall(args);
  };
  await service.history('bob', shared.id);
  assert.equal(recalledResource, `project:${projectId}`);
  for (const action of [
    () => service.createThread('outsider', { ...settings, projectId }),
    () => service.listThreads('outsider', 0, projectId),
    () => service.getThread('outsider', shared.id),
    () => service.history('outsider', shared.id),
    () => service.subscribe('outsider', shared.id, () => {}),
    () => service.updateThread('outsider', shared.id, { title: 'hijack' }),
    () => service.deleteThread('outsider', shared.id),
    () => service.run('outsider', shared.id, input('outsider1')),
    () => service.abort('outsider', shared.id),
    () => service.resume('outsider', shared.id),
    () => service.cancelQueued('outsider', shared.id, 'any'),
    () => service.getThread('bob', personal.id),
    () => service.updateThread('bob', shared.id, { title: 'not mine' }),
    () => service.deleteThread('bob', shared.id),
  ])
    await assert.rejects(action, ThreadError);
  await service.updateThread('carol', shared.id, { title: 'Admin title' });
  assert.equal(
    (await service.getThread('bob', shared.id)).thread.title,
    'Admin title',
  );
});

test('members observe one shared runtime; revocation closes subscriptions and deletion excludes concurrent work', async (t) => {
  const { memory, threads } = fakeMemory();
  const access = projectAccess();
  let release: (() => void) | undefined;
  let active = 0;
  let maxActive = 0;
  const validated: Array<string | undefined> = [];
  const service = new ThreadService(
    memory,
    {
      ...runner,
      async validate(_userId, _input, id) {
        validated.push(id);
      },
      async execute({ input: request, onMessage, onStatus, signal }) {
        onStatus('running');
        maxActive = Math.max(maxActive, ++active);
        onMessage({
          id: `reply-${request.id}`,
          role: 'assistant',
          parts: [{ type: 'text', text: 'shared reply' }],
        });
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', resolve as () => void, {
            once: true,
          });
        });
        active--;
      },
    },
    access,
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', {
    ...settings,
    projectId,
  });
  const alice: ThreadSnapshot<UIMessage>[] = [],
    bob: ThreadSnapshot<UIMessage>[] = [];
  let revoked = false;
  const off = await service.subscribe('alice', thread.id, (value) =>
    alice.push(structuredClone(value)),
  );
  await service.subscribe(
    'bob',
    thread.id,
    (value) => bob.push(structuredClone(value)),
    () => {
      revoked = true;
    },
  );
  await service.run('bob', thread.id, input('message01'));
  await until(
    () =>
      !!release &&
      alice.some((value) =>
        value.messages.some((message) => message.id === 'reply-message01'),
      ) &&
      bob.some((value) =>
        value.messages.some((message) => message.id === 'reply-message01'),
      ),
  );
  assert.deepEqual(alice, bob);
  assert.equal(validated[0], projectId);
  await assert.rejects(
    () => service.withProjectDeletion(projectId, async () => {}),
    (error: ThreadError) => error.code === 'PROJECT_BUSY',
  );
  await service.run('alice', thread.id, input('message02'));
  off();
  assert.equal(
    (await service.getThread('alice', thread.id)).thread.status,
    'running',
  );
  access.members.delete('bob');
  service.invalidateProject(projectId, 'bob');
  assert.equal(revoked, true);
  const count = bob.length;
  release!();
  await until(
    () =>
      !!active && threads.get(thread.id)?.metadata?.activeId === 'message02',
  );
  await service.abort('alice', thread.id);
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status ===
      'canceled',
  );
  assert.equal(maxActive, 1);
  assert.equal(bob.length, count);
  await assert.rejects(() => service.history('bob', thread.id), ThreadError);
  const stored = threads.get(thread.id)!;
  assert.equal(stored.metadata?.createdBy, 'alice');
  assert.equal(stored.metadata?.workspace, `/workspace/projects/${projectId}`);
  await service.withProjectDeletion(projectId, async () =>
    access.members.clear(),
  );
  await assert.rejects(
    () => service.createThread('alice', { ...settings, projectId }),
    ThreadError,
  );
});

test('project workspace and skills stay separate from personal and other project directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aime-project-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    '.agents/skills/team/search',
    'users/alice/.agents/skills/private-only',
    `projects/${projectId}/.agents/skills/local/search`,
  ]) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'SKILL.md'), '# Skill');
  }
  const skills = await discoverProjectSkills(root, projectId);
  assert.equal(skills.length, 1);
  assert.equal(
    skills[0].path,
    join(root, `projects/${projectId}/.agents/skills/local/search`),
  );
  assert.equal(skills[0].group, 'local');
  const path = await createProjectWorkspace(root, projectId);
  assert.equal(path, projectDirectory(root, projectId));
  assert.equal(await createProjectWorkspace(root, projectId), path);
  assert.throws(() => projectDirectory(root, '../outside'), ThreadError);
  assert.throws(() => getWorkspace(root, 'alice', path), ThreadError);
  assert.throws(
    () => getWorkspace(root, 'alice', `${path}-other`, projectId),
    ThreadError,
  );
  await getWorkspace(root, 'alice', path, projectId).destroy();
});
