import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth } from '@aime/auth';
import type { ChatSkill } from '@aime/shared/threads';
import { createApp } from '../apps/server/src/app.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';
import type { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import {
  completeSlashCommand,
  filterCommandGroups,
  getSlashCommand,
  type SlashCommandGroup,
} from '../apps/web/src/components/chat/slash-command.js';
import { skillCommandGroup } from '../apps/web/src/components/chat/skill-commands.js';

test('slash completion only targets the leading command at a collapsed caret and preserves the prompt', () => {
  assert.deepEqual(getSlashCommand('/', 1), { query: '', end: 1 });
  assert.deepEqual(getSlashCommand('/review explain this', 4), {
    query: 'rev',
    end: 7,
  });
  for (const [text, start, end] of [
    ['hello /review', 13, 13],
    ['https://example.com', 19, 19],
    ['/tmp/file', 4, 4],
    ['/review task', 10, 10],
    ['/review', 1, 5],
    ['/review', 0, 0],
  ] as const)
    assert.equal(getSlashCommand(text, start, end), null);
  assert.deepEqual(completeSlashCommand('/rev', 4, 'review'), {
    text: '/review ',
    caret: 8,
  });
  assert.deepEqual(completeSlashCommand('/rev  keep all text', 4, 'review'), {
    text: '/review  keep all text',
    caret: 8,
  });
  assert.deepEqual(completeSlashCommand('/rev\n下一行', 4, 'review'), {
    text: '/review \n下一行',
    caret: 8,
  });
});

test('command groups preserve category and directory hierarchy alongside non-skill commands', () => {
  const skills = skillCommandGroup(
    [
      { name: 'review', description: '检查代码', group: 'owner/repo' },
      { name: 'writer', description: 'Write docs', group: '' },
      { name: 'search', description: 'Search files', group: 'owner/repo' },
      { name: 'organize', description: 'Organize documents', group: 'test' },
      { name: 'deep', description: 'Deep skill', group: 'test/owner/repo' },
    ],
    '技能',
  );
  assert.deepEqual(
    skills.sections.map((section) => section.label),
    [undefined, 'owner/repo', 'test', 'test/owner/repo'],
  );
  assert.deepEqual(
    skills.sections[1].items.map((item) => item.name),
    ['review', 'search'],
  );
  const general: SlashCommandGroup = {
    id: 'general',
    label: '常用',
    sections: [
      {
        id: '',
        items: [
          { id: 'command:help', name: 'help', description: '查看命令帮助' },
        ],
      },
    ],
  };
  const groups = [general, skills];
  const names = (query: string) =>
    filterCommandGroups(groups, query).flatMap((group) =>
      group.sections.flatMap((section) =>
        section.items.map((item) => item.name),
      ),
    );
  assert.deepEqual(names(''), [
    'help',
    'writer',
    'review',
    'search',
    'organize',
    'deep',
  ]);
  assert.deepEqual(names('REVIEW'), ['review']);
  assert.deepEqual(names('代码'), ['review']);
  assert.deepEqual(names('owner/repo'), ['review', 'search', 'deep']);
  assert.deepEqual(names('test'), ['organize', 'deep']);
  assert.deepEqual(names('帮助'), ['help']);
  assert.deepEqual(names('missing'), []);
  assert.deepEqual(
    filterCommandGroups(groups, 'help').map((group) => group.id),
    ['general'],
  );
  assert.equal(skills.sections.length, 4);
});

test('skill catalog uses runtime metadata, scoped overrides and user-invocable visibility without exposing paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chat-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectId = 'project123456789';
  async function skill(
    path: string,
    name: string,
    description: string,
    extra = '',
  ) {
    const dir = join(root, path, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n${extra}---\nInstructions for ${name}.\n`,
    );
  }
  await skill('.agents/skills/owner/repo', 'review', 'Global review');
  await skill('.agents/skills', 'writer', 'Write documentation');
  await skill(
    '.agents/skills',
    'hidden',
    'Internal only',
    'user-invocable: false\n',
  );
  await skill('users/alice/.agents/skills/test', 'review', 'Personal review');
  await skill('users/alice/.agents/skills', 'private-only', 'Personal secret');
  await skill(
    `projects/${projectId}/.agents/skills/project/team`,
    'review',
    'Project review',
  );
  const personal = await listChatSkills(root, 'alice');
  assert.deepEqual(personal, [
    { name: 'private-only', description: 'Personal secret', group: '' },
    { name: 'review', description: 'Personal review', group: 'test' },
    { name: 'writer', description: 'Write documentation', group: '' },
  ]);
  assert.deepEqual(await listChatSkills(root, 'alice', projectId), [
    { name: 'review', description: 'Project review', group: 'project/team' },
    { name: 'writer', description: 'Write documentation', group: '' },
  ]);
  assert.deepEqual(
    (await listChatSkills(root, 'bob')).map((skill) => skill.name),
    ['review', 'writer'],
  );
  assert.equal((await listChatSkills(root, 'bob'))[0].group, 'owner/repo');
  await skill('.agents/skills/test/owner/repo', 'deep-skill', 'Deep skill');
  assert.equal(
    (await listChatSkills(root, 'alice')).find(
      (skill) => skill.name === 'deep-skill',
    )?.group,
    'test/owner/repo',
  );
  await skill(
    'users/alice/.agents/skills',
    'new-skill',
    'Newly installed skill',
  );
  assert.ok(
    (await listChatSkills(root, 'alice')).some(
      (skill) => skill.name === 'new-skill',
    ),
  );
});

test('a directory is a group until it contains its own SKILL.md', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chat-skill-groups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const group = join(root, '.agents/skills/test');
  await mkdir(join(group, 'skill-one'), { recursive: true });
  await writeFile(
    join(group, 'skill-one/SKILL.md'),
    '---\nname: skill-one\ndescription: Nested skill\n---\nInstructions.',
  );
  assert.deepEqual(await listChatSkills(root, 'alice'), [
    { name: 'skill-one', description: 'Nested skill', group: 'test' },
  ]);
  await writeFile(
    join(group, 'SKILL.md'),
    '---\nname: test\ndescription: Standalone skill\n---\nInstructions.',
  );
  assert.deepEqual(await listChatSkills(root, 'alice'), [
    { name: 'test', description: 'Standalone skill', group: '' },
  ]);
});

test('skills API authenticates drafts and existing chats, derives thread scope and rechecks membership', async (t) => {
  const { memory } = fakeMemory();
  const projectId = 'project123456789';
  let member = true;
  let revokeOnRead = false;
  const reads: Array<{ userId: string; projectId?: string }> = [];
  const service = new ThreadService(
    memory,
    {
      async validate() {},
      async createWorkspace() {
        return '/unused';
      },
      async execute() {},
      async listSkills(userId, projectId) {
        reads.push({ userId, projectId });
        if (revokeOnRead) member = false;
        return [
          {
            name: projectId ? 'project-skill' : 'personal-skill',
            description: 'Test skill',
            group: 'owner/repo',
          },
        ];
      },
    },
    {
      async assertMember(userId, id) {
        if (id !== projectId || userId !== 'alice' || !member)
          throw new ThreadError('PROJECT_NOT_FOUND', 404);
        return { role: 'owner' as const };
      },
    },
  );
  t.after(() => service.shutdown());
  const personal = await service.createThread('alice', {
    model: null,
    reasoningEffort: 'auto',
  });
  const shared = await service.createThread('alice', {
    model: null,
    reasoningEffort: 'auto',
    projectId,
  });
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const userId = headers.get('x-test-user');
        return userId
          ? { user: { id: userId }, session: { id: 'test' } }
          : null;
      },
    },
  } as unknown as Auth;
  const server = createApp(auth, undefined, {
    threads: service,
    models: {} as LanguageModelService,
    webOrigin: 'http://localhost:5173',
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = (query = '', userId = 'alice') =>
    fetch(`http://127.0.0.1:${address.port}/api/threads/skills${query}`, {
      headers: userId ? { 'x-test-user': userId } : {},
    });
  assert.equal((await request('', '')).status, 401);
  assert.equal((await request('?projectId=invalid')).status, 400);
  assert.equal((await request(`?threadId=${personal.id}`, 'bob')).status, 404);
  assert.equal((await request(`?projectId=${projectId}`, 'bob')).status, 404);
  assert.equal(reads.length, 0);
  for (const [query, name] of [
    ['', 'personal-skill'],
    [`?projectId=${projectId}`, 'project-skill'],
    [`?threadId=${shared.id}`, 'project-skill'],
    [`?threadId=${personal.id}&projectId=${projectId}`, 'personal-skill'],
  ]) {
    const response = await request(query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const skills = (await response.json()) as ChatSkill[];
    assert.equal(skills[0].name, name);
    assert.equal(skills[0].group, 'owner/repo');
  }
  assert.deepEqual(reads.at(-1), { userId: 'alice', projectId: undefined });
  revokeOnRead = true;
  assert.equal((await request(`?projectId=${projectId}`)).status, 404);
  member = true;
  assert.equal((await request(`?threadId=${shared.id}`)).status, 404);
});
