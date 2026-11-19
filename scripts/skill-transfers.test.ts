import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import type { Auth } from '@aime/auth';
import { Pool } from 'pg';
import {
  createDataSource,
  CreateProjectTables1780000002000,
  Project,
  ProjectMember,
} from '@aime/db';
import { ProjectListState1780000003000 } from '../packages/db/src/migrations/1780000003000-project-list-state.js';
import { ProjectService } from '../apps/server/src/modules/projects/service.js';
import type { ProjectRole } from '@aime/shared/projects';
import type {
  InstalledSkill,
  SkillSharingOptions,
  SkillDestination,
} from '@aime/shared/skills';
import { createApp } from '../apps/server/src/app.js';
import { requireProjectManager } from '../apps/server/src/modules/projects/permissions.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import {
  readSkillSources,
  serializeSkillSources,
} from '../apps/server/src/modules/skills/sources.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';

const origin = 'http://localhost:5173';
const projectId = 'project000000001';
const otherId = 'project000000002';
const route = '/api/skills/sharing';
const path = 'owner/repo/research';
const global = { scope: 'global' } as const;
const project = { scope: 'project', projectId } as const;
const fromGlobal = { scope: 'personal', from: global } as const;
const fromProject = { scope: 'personal', from: project } as const;
const publisherNames = async (ids: string[]) =>
  new Map(ids.map((id) => [id, 'User ' + id]));

async function put(
  directory: string,
  path: string,
  data: string | Buffer,
  mode?: number,
) {
  const filename = join(directory, path);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, data, { mode });
}

function manifest(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
}

function install(root: string, path: string, description = 'Private research') {
  return put(root, `${path}/SKILL.md`, manifest(basename(path), description));
}

async function fixture(
  t: test.TestContext,
  download?: ConstructorParameters<typeof SkillService>[1],
  projectService?: ProjectService,
) {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), 'skill-transfers-')),
  );
  const service = new SkillService(workspace, download);
  t.after(async () => {
    await service.dispose();
    await rm(workspace, { recursive: true, force: true });
  });
  const admins = new Set(['alice', 'bob']);
  const roles = new Map<string, ProjectRole>([
    ['alice', 'owner'],
    ['bob', 'admin'],
    ['reader', 'member'],
  ]);
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        if (!id) return null;
        return {
          user: {
            id,
            name: `User ${id}`,
            username: id,
            role: admins.has(id) ? 'admin' : 'user',
          },
          session: { id },
        };
      },
    },
  } as unknown as Auth;
  const archivedProjects = new Set<string>();
  const projects = projectService ?? {
    listManagedSkillProjects: async (userId: string) =>
      ['admin', 'owner'].includes(roles.get(userId) ?? '')
        ? [
            {
              id: projectId,
              name: 'Research',
              archived: archivedProjects.has(projectId),
            },
          ]
        : [],
    withManagementAccess: async <T>(
      userId: string,
      id: string,
      action: (
        manager: unknown,
        project: { id: string; name: string; archived: boolean },
      ) => Promise<T>,
    ) => {
      const role = roles.get(userId);
      if (!role || (id !== projectId && id !== otherId))
        throw new ThreadError('PROJECT_NOT_FOUND', 404);
      requireProjectManager(id === projectId ? role : 'member');
      return action(undefined, {
        id,
        name: 'Research',
        archived: archivedProjects.has(id),
      });
    },
  };
  const app = createApp(
    auth,
    undefined,
    {
      projects,
      users: { skillPublisherNames: publisherNames },
      webOrigin: origin,
    } as unknown as NonNullable<Parameters<typeof createApp>[2]>,
    { service, webOrigin: origin },
  );
  function request(
    userId: string,
    url: string,
    body?: unknown,
    requestOrigin = origin,
  ) {
    return app.request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-test-user': userId,
        origin: requestOrigin,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const setSharing = (
    userId: string,
    path: string,
    target: SkillDestination | { scope: 'personal'; from: SkillDestination },
  ) => request(userId, route, { path, target });
  return {
    workspace,
    service,
    admins,
    roles,
    archivedProjects,
    request,
    setSharing,
    options: async (id: string) =>
      result<SkillSharingOptions>(await request(id, route)),
    projectRoot: join(workspace, '.agents', 'project-skills', projectId),
    root: service.forUser('alice').root,
  };
}

async function result<T>(response: Response): Promise<T> {
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

const names = (skills: Array<{ name: string }>) =>
  skills.map((skill) => skill.name).sort();

test('personal Skill stays editable while shared through independent global and project links', async (t) => {
  const {
    workspace,
    root,
    service,
    request,
    setSharing,
    admins,
    options,
    projectRoot,
  } = await fixture(t);
  await install(root, path);
  const asset = Buffer.from([0, 255, 0, 42]);
  await put(root, path + '/assets/example.bin', asset);
  await result(await setSharing('alice', path, global));
  await result(await setSharing('alice', path, project));
  const source = join(root, path);
  for (const directory of [join(service.root, path), join(projectRoot, path)]) {
    assert.ok((await lstat(directory)).isSymbolicLink());
    assert.equal(await realpath(directory), await realpath(source));
    assert.deepEqual(
      await readFile(join(directory, 'assets/example.bin')),
      asset,
    );
  }
  assert.deepEqual((await readdir(source)).sort(), ['SKILL.md', 'assets']);
  assert.deepEqual((await readdir(join(workspace, '.agents'))).sort(), [
    'project-skills',
    'skills',
  ]);
  assert.equal((await options('alice')).shared.length, 2);
  assert.deepEqual((await options('bob')).shared, []);
  const catalog = await result<{ skills: InstalledSkill[] }>(
    await request('bob', '/api/admin/skills'),
  );
  assert.deepEqual(catalog.skills[0].sharing, {
    userId: 'alice',
    userName: 'User alice',
    scope: 'global',
  });
  const view = await result<{ content: string }>(
    await request('bob', '/api/admin/skills/content?path=' + path),
  );
  assert.equal(view.content, manifest('research', 'Private research'));
  const read = await result<{ version: string }>(
    await request(
      'alice',
      '/api/skills/files/preview?skill=' + path + '&path=SKILL.md',
    ),
  );
  const edit = {
    path: 'SKILL.md',
    text: manifest('research', 'Edited at the source'),
    version: read.version,
  };
  const save = (userId: string, scope: 'skills' | 'personalSkills') =>
    request(userId, '/api/rpc/' + scope + '/files/save', {
      json: { query: { skill: path }, body: edit },
    });
  assert.equal((await save('bob', 'skills')).status, 403);
  await result(await save('alice', 'personalSkills'));
  const chatSkills = await listChatSkills(
    workspace,
    'reader',
    undefined,
    publisherNames,
  );
  assert.deepEqual(
    chatSkills.map((skill) => [
      skill.name,
      skill.description,
      skill.sourceUserName,
    ]),
    [['research', 'Edited at the source', 'User alice']],
  );
  assert.equal((await setSharing('bob', path, fromGlobal)).status, 403);
  admins.delete('alice');
  assert.equal((await setSharing('alice', path, fromGlobal)).status, 403);
  admins.add('alice');
  await result(await setSharing('alice', path, fromGlobal));
  assert.deepEqual(names(await listChatSkills(workspace, 'reader')), []);
  assert.deepEqual(
    names(await listChatSkills(workspace, 'reader', projectId)),
    ['research'],
  );
  assert.deepEqual(names(await listChatSkills(workspace, 'alice')), [
    'research',
  ]);
  await result(await setSharing('alice', path, fromProject));
  assert.deepEqual((await options('alice')).shared, []);
  assert.deepEqual(await readFile(join(source, 'assets/example.bin')), asset);
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), edit.text);
});

test('sharing checks authentication, origin, current destination privileges and source ownership on both transports', async (t) => {
  const {
    admins,
    roles,
    root,
    request,
    setSharing,
    workspace,
    projectRoot,
    options,
  } = await fixture(t);
  await install(root, path);
  admins.delete('alice');
  const targets = await options('alice');
  assert.equal(targets.global, false);
  assert.deepEqual(
    targets.projects.map((target) => target.id),
    [projectId],
  );
  assert.equal((await request('', route)).status, 401);
  assert.equal(
    (
      await request(
        'alice',
        route,
        { path, target: project },
        'https://elsewhere.test',
      )
    ).status,
    403,
  );
  assert.equal((await setSharing('alice', path, global)).status, 403);
  assert.equal((await setSharing('reader', path, project)).status, 403);
  assert.equal(
    (await setSharing('alice', path, { scope: 'project', projectId: otherId }))
      .status,
    403,
  );
  assert.equal((await setSharing('bob', path, project)).status, 404);
  assert.equal(
    (await request('bob', route, { path, target: project, userId: 'alice' }))
      .status,
    400,
  );
  const rpc = '/api/rpc/personalSkills/setSharing';
  const body = { json: { body: { path, target: project } } };
  assert.equal(
    (await request('alice', rpc, body, 'https://elsewhere.test')).status,
    403,
  );
  assert.equal((await request('reader', rpc, body)).status, 403);
  await result(await request('alice', rpc, body));
  assert.deepEqual(names(await listChatSkills(workspace, 'reader')), []);
  assert.deepEqual(
    names(await listChatSkills(workspace, 'reader', projectId)),
    ['research'],
  );
  roles.set('alice', 'member');
  assert.equal((await setSharing('alice', path, fromProject)).status, 403);
  assert.equal(
    await readFile(join(projectRoot, path, 'SKILL.md'), 'utf8'),
    manifest('research', 'Private research'),
  );
  roles.set('alice', 'admin');
  await result(await setSharing('alice', path, fromProject));
  assert.deepEqual(
    names(await listChatSkills(workspace, 'reader', projectId)),
    [],
  );
});

test('same-name conflicts and concurrent publishers leave every losing package at its source', async (t) => {
  const { service, root, setSharing } = await fixture(t);
  await install(root, path, 'Alice');
  await install(service.root, 'another/research', 'Existing');
  assert.equal((await setSharing('alice', path, global)).status, 409);
  assert.equal((await service.list()).skills[0].description, 'Existing');
  assert.equal(
    (await service.forUser('alice').list()).skills[0].description,
    'Alice',
  );
  await service.remove('another/research');
  await install(service.forUser('bob').root, path, 'Bob');
  const [alice, bob] = await Promise.all([
    setSharing('alice', path, global),
    setSharing('bob', path, global),
  ]);
  assert.deepEqual([alice.status, bob.status].sort(), [200, 409]);
  const winner = alice.ok ? 'alice' : 'bob';
  const loser = alice.ok ? 'bob' : 'alice';
  assert.deepEqual(names((await service.forUser(winner).list()).skills), [
    'research',
  ]);
  assert.deepEqual(names((await service.forUser(loser).list()).skills), [
    'research',
  ]);
  assert.equal(
    (await service.list()).skills[0].description.toLowerCase(),
    winner,
  );
  await install(service.forUser(winner).root, path, 'New private version');
  await result(await setSharing(winner, path, fromGlobal));
  assert.equal(
    (await service.forUser(winner).list()).skills[0].description,
    'New private version',
  );
  assert.deepEqual((await service.list()).skills, []);
});

test('sharing a whole-project entry links the original package and all its enabled entries and resources', async (t) => {
  const { root, projectRoot, setSharing, workspace, options } =
    await fixture(t);
  const group = 'owner/toolbox';
  const entries = [
    { name: 'first', path: 'skills/One/SKILL.md' },
    { name: 'second', path: 'skills/Two/SKILL.md' },
  ];
  const sources = [
    {
      url: 'https://github.com/owner/toolbox',
      ref: 'main',
      scope: '',
      installation: { mode: 'project' as const, entries },
    },
  ];
  for (const entry of entries)
    await put(root, `${group}/${entry.path}`, manifest(entry.name, entry.name));
  await put(
    root,
    `${group}/.skill-meta/.skill-project.json`,
    JSON.stringify({ version: 2, root: '.', entries }),
  );
  await put(
    root,
    `${group}/.skill-meta/.skill-sources.json`,
    serializeSkillSources(sources),
  );
  await put(root, `${group}/lib/tool.py`, 'VERSION = 1\n');
  await put(root, `${group}/.config`, 'upstream');
  const moved = await result<InstalledSkill[]>(
    await setSharing('alice', `${group}/skills/One`, project),
  );
  assert.deepEqual(names(moved), ['first', 'second']);
  const { shared } = await options('alice');
  assert.deepEqual(names(shared), ['first', 'second']);
  assert.deepEqual(shared[0].sharing, {
    userId: 'alice',
    userName: 'User alice',
    scope: 'project',
    projectId,
    projectName: 'Research',
  });
  assert.deepEqual(names(await listChatSkills(workspace, 'alice')), [
    'first',
    'second',
  ]);
  assert.ok((await lstat(join(projectRoot, group))).isSymbolicLink());
  const projectChat = await listChatSkills(
    workspace,
    'bob',
    projectId,
    publisherNames,
  );
  assert.deepEqual(names(projectChat), ['first', 'second']);
  assert.ok(
    projectChat.every((skill) => skill.sourceUserName === 'User alice'),
  );
  assert.deepEqual(await readSkillSources(join(projectRoot, group)), sources);
  assert.equal(
    await readFile(join(projectRoot, group, 'lib/tool.py'), 'utf8'),
    'VERSION = 1\n',
  );
  await result(await setSharing('alice', `${group}/skills/Two`, fromProject));
  assert.deepEqual(await readSkillSources(join(root, group)), sources);
  assert.equal(
    await readFile(join(root, group, '.config'), 'utf8'),
    'upstream',
  );
  assert.deepEqual(names(await listChatSkills(workspace, 'alice')), [
    'first',
    'second',
  ]);
});

test('links within a personal skill cannot be promoted to a shared scope', async (t) => {
  const { workspace, service, root, setSharing } = await fixture(t);
  await install(root, path);
  await put(workspace, 'private.txt', 'private');
  await symlink(join(workspace, 'private.txt'), join(root, path, 'link'));
  assert.equal((await setSharing('alice', path, global)).status, 403);
  assert.deepEqual((await service.list()).skills, []);
  assert.deepEqual(names((await service.forUser('alice').list()).skills), [
    'research',
  ]);
});

test('a shared repository remains subscribed to updates at its personal source', async (t) => {
  const upstream = Buffer.from(manifest('research', 'New upstream version'));
  const { root, setSharing, service, request } = await fixture(t, async () => ({
    commit: 'a'.repeat(40),
    files: [
      {
        path: 'research/SKILL.md',
        oid: 'manifest',
        size: upstream.length,
        mode: '100644',
      },
    ],
    ref: 'main',
    read: async () => upstream,
    dispose: async () => {},
  }));
  await install(root, path);
  const group = 'owner/repo';
  const sources = [
    {
      url: 'https://github.com/owner/repo',
      ref: 'main',
      scope: '',
      installation: { mode: 'collection' as const },
    },
  ];
  await put(
    root,
    group + '/.skill-sources.json',
    serializeSkillSources(sources),
  );
  await result(await setSharing('alice', path, global));
  assert.deepEqual(await readSkillSources(join(service.root, group)), []);
  assert.deepEqual(await readSkillSources(join(root, group)), sources);
  assert.ok(
    [403, 409].includes(
      (await request('bob', '/api/admin/skills/groups/update', { group }))
        .status,
    ),
  );
  await result(await request('alice', '/api/skills/groups/update', { group }));
  assert.equal(
    (await service.list()).skills[0].description,
    'New upstream version',
  );
  assert.ok((await lstat(join(service.root, path))).isSymbolicLink());
});

test('removing a shared personal installation clears links before the same path is reused', async (t) => {
  const { root, projectRoot, service, setSharing, options } = await fixture(t);
  await install(root, path);
  await result(await setSharing('alice', path, global));
  await result(await setSharing('alice', path, project));
  await service.forUser('alice').remove(path);
  for (const sharedRoot of [projectRoot, service.root])
    await assert.rejects(lstat(join(sharedRoot, path)), { code: 'ENOENT' });
  await install(root, path, 'New private version');
  assert.deepEqual((await options('alice')).shared, []);
  assert.deepEqual((await service.list()).skills, []);
});

test('old moved directories can still be withdrawn before sharing them as links', async (t) => {
  const { root, workspace, service, setSharing, options } = await fixture(t);
  await install(service.root, path, 'Edited after legacy move');
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const location = digest(JSON.stringify(['global', path]));
  const record = location + '.' + digest('alice') + '.json';
  const token = randomUUID();
  const sharing = { scope: 'global', userId: 'alice', userName: 'User alice' };
  await put(
    workspace,
    '.agents/skill-origins/' + record,
    JSON.stringify({ sharing, unit: path, token }),
  );
  await put(service.root, path + '/.skill-origin-' + location, token);
  const { shared } = await options('alice');
  assert.equal(shared[0]?.sharing?.legacyMoved, true);
  await result(await setSharing('alice', path, fromGlobal));
  assert.deepEqual(await readdir(join(root, path)), ['SKILL.md']);
  assert.deepEqual(await readdir(join(workspace, '.agents/skill-origins')), []);
  await result(await setSharing('alice', path, global));
  assert.ok((await lstat(join(service.root, path))).isSymbolicLink());
  assert.deepEqual(await readdir(join(workspace, '.agents/skill-origins')), []);
});

async function checkArchiveLifecycle(
  {
    root,
    setSharing,
    options,
    projectRoot,
  }: Awaited<ReturnType<typeof fixture>>,
  archive: (value: boolean) => Promise<void>,
) {
  await install(root, path);
  await install(root, 'new-skill');
  assert.deepEqual((await options('alice')).projects, [
    { id: projectId, name: 'Research' },
  ]);
  await result(await setSharing('alice', path, project));
  await archive(true);
  const archived = await options('alice');
  assert.deepEqual(archived.projects, []);
  assert.deepEqual(names(archived.shared), ['research']);
  const refused = await setSharing('alice', 'new-skill', project);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'PROJECT_ARCHIVED');
  assert.equal(
    await readFile(join(root, 'new-skill/SKILL.md'), 'utf8'),
    manifest('new-skill', 'Private research'),
  );
  await assert.rejects(stat(join(projectRoot, 'new-skill')), {
    code: 'ENOENT',
  });
  await result(await setSharing('alice', path, fromProject));
  assert.deepEqual((await options('alice')).shared, []);
  await archive(false);
  assert.deepEqual((await options('alice')).projects, [
    { id: projectId, name: 'Research' },
  ]);
  await result(await setSharing('alice', 'new-skill', project));
  assert.deepEqual(names((await options('alice')).shared), ['new-skill']);
}

test('archived projects disappear from the picker and reject new shares while allowing the original manager to withdraw a skill', async (t) => {
  const scope = await fixture(t);
  await checkArchiveLifecycle(scope, async (archived) => {
    if (archived) scope.archivedProjects.add(projectId);
    else scope.archivedProjects.delete(projectId);
  });
});

test(
  'PostgreSQL project archive and restore are reflected in skill sharing requests',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `skill_archive_${randomBytes(8).toString('hex')}`;
    const url = process.env.TEST_DATABASE_URL!;
    const pool = new Pool({ connectionString: url });
    const database = createDataSource(url).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
      migrations: [
        CreateProjectTables1780000002000,
        ProjectListState1780000003000,
      ],
    });
    t.after(async () => {
      if (database.isInitialized) await database.destroy();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.runMigrations();
    await database
      .getRepository(Project)
      .save({ id: projectId, name: 'Research', createdBy: 'owner' });
    await database.getRepository(ProjectMember).save([
      { projectId, userId: 'owner', role: 'owner' },
      { projectId, userId: 'alice', role: 'admin' },
      { projectId, userId: 'reader', role: 'member' },
    ]);
    const projects = new ProjectService(database);
    const scope = await fixture(t, undefined, projects);
    assert.deepEqual((await scope.options('reader')).projects, []);
    await checkArchiveLifecycle(scope, async (archived) => {
      await projects.update('owner', projectId, { archived });
      assert.deepEqual(await projects.listManagedSkillProjects('alice'), [
        { id: projectId, name: 'Research', archived },
      ]);
    });
  },
);
