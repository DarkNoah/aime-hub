import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth } from '@aime/auth';
import { createApp } from '../apps/server/src/app.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import { SkillError } from '../apps/server/src/modules/skills/errors.js';
import {
  resolveRepositoryScope,
  type GitHubRepository,
  type RepositorySnapshot,
} from '../apps/server/src/modules/skills/github.js';
import {
  SKILL_SOURCES_FILE,
  readSkillSources as readSkillSourceRecords,
  type SkillSource,
} from '../apps/server/src/modules/skills/sources.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';

const manifest = (name: string, description = 'Original instructions') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${description}\n`;
const source = 'https://github.com/owner/repo/tree/feature/skills/catalog';
const readSkillSources = async (directory: string) =>
  (await readSkillSourceRecords(directory)).map((source) => source.url);
const group = 'owner/repo';
const skillPath = `${group}/one`;

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'personal-skills-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const files = new Map([
    ['catalog/one/SKILL.md', manifest('one')],
    ['catalog/one/obsolete.txt', 'old resource'],
    ['catalog/two/SKILL.md', manifest('two')],
    ['outside/other/SKILL.md', manifest('other')],
  ]);
  const downloads: GitHubRepository[] = [];
  const disposed: number[] = [];
  let failResource = false;
  let extraRef = '';
  const download = async (
    repository: GitHubRepository,
    _signal?: AbortSignal,
    original?: Pick<SkillSource, 'ref' | 'scope'>,
  ): Promise<RepositorySnapshot> => {
    downloads.push(repository);
    const id = downloads.length;
    const snapshot = new Map(files);
    const scope = original
      ? { ref: original.ref ?? undefined, scopePath: original.scope }
      : repository.refPath
        ? resolveRepositoryScope(
            repository.refPath,
            `${'a'.repeat(40)}\trefs/heads/feature/skills\n${'a'.repeat(40)}\trefs/heads/main${extraRef}`,
          )
        : undefined;
    if (
      scope?.scopePath &&
      ![...snapshot.keys()].some((path) =>
        repository.kind === 'blob'
          ? path === scope.scopePath
          : path.startsWith(`${scope.scopePath}/`),
      )
    )
      throw new SkillError('SKILL_SOURCE_NOT_FOUND', 404);
    return {
      commit: 'a'.repeat(40),
      ...scope,
      fileOnly: repository.kind === 'blob',
      files: [...snapshot].map(([path, value]) => ({
        path,
        oid: path,
        mode: '100644',
        size: Buffer.byteLength(value),
      })),
      read: async (file) => {
        if (failResource && !file.path.endsWith('SKILL.md'))
          throw new Error('resource copy failed');
        return Buffer.from(snapshot.get(file.path)!);
      },
      dispose: async () => {
        disposed.push(id);
      },
    };
  };
  const service = new SkillService(workspace, download);
  t.after(() => service.dispose());
  const alice = service.forUser('alice');
  const install = async (
    target = alice,
    url = source,
    paths = ['catalog/one/SKILL.md'],
  ) => {
    const scan = await target.scan(url);
    return target.install(scan.id, paths);
  };
  const cleanStaging = async () => {
    const entries = await readdir(join(workspace, 'users/alice/.agents'));
    assert.deepEqual(entries, ['skills']);
  };
  return {
    workspace,
    service,
    alice,
    files,
    downloads,
    disposed,
    install,
    cleanStaging,
    addAmbiguousBranch: () => {
      extraRef = `\n${'a'.repeat(40)}\trefs/heads/feature/skills/catalog`;
    },
    failCopy: () => {
      failResource = true;
    },
  };
}

test('personal catalogs, scan tokens, previews and chat discovery remain scoped to their owner', async (t) => {
  const { service, alice, install, files, workspace } = await fixture(t);
  const bob = service.forUser('bob');
  await install(service);
  files.set('catalog/one/SKILL.md', manifest('one', 'Alice instructions'));
  const scan = await alice.scan(source);
  await assert.rejects(bob.install(scan.id, ['catalog/one/SKILL.md']), {
    code: 'SKILL_SCAN_EXPIRED',
  });
  await bob.discard(scan.id);
  await alice.install(scan.id, ['catalog/one/SKILL.md']);
  assert.equal((await alice.list()).skills.length, 1);
  assert.equal((await bob.list()).skills.length, 0);
  assert.match((await alice.read(skillPath)).content, /Alice instructions/);
  assert.match(
    (await service.read(skillPath)).content,
    /Original instructions/,
  );
  await assert.rejects(bob.read(skillPath), { code: 'SKILL_NOT_FOUND' });
  await assert.rejects(bob.updateGroup(group), { code: 'SKILL_NOT_FOUND' });
  await assert.rejects(bob.remove(skillPath), { code: 'SKILL_NOT_FOUND' });
  assert.equal(
    (await listChatSkills(workspace, 'alice'))[0].description,
    'Alice instructions',
  );
  assert.equal(
    (await listChatSkills(workspace, 'bob'))[0].description,
    'Original instructions',
  );
  assert.equal(
    (await listChatSkills(workspace, 'alice', 'project123456789'))[0]
      .description,
    'Original instructions',
  );
});

test('group update replaces the whole folder with every latest skill under the original slash branch and path', async (t) => {
  const { alice, files, install, downloads, disposed, cleanStaging } =
    await fixture(t);
  await install();
  const directory = join(alice.root, group);
  await writeFile(join(directory, 'loose-old.txt'), 'old');
  assert.deepEqual(await readSkillSources(directory), [source]);
  assert.deepEqual(await readSkillSourceRecords(directory), [
    { url: source, ref: 'feature/skills', scope: 'catalog' },
  ]);
  files.delete('catalog/one/obsolete.txt');
  files.set('catalog/one/SKILL.md', manifest('one', 'Latest instructions'));
  files.set('catalog/three/SKILL.md', manifest('three'));
  const updated = await alice.updateGroup(group);
  assert.deepEqual(updated.map((skill) => skill.name).sort(), [
    'one',
    'three',
    'two',
  ]);
  assert.equal(downloads.at(-1)?.refPath, 'feature/skills/catalog');
  assert.match((await alice.read(skillPath)).content, /Latest instructions/);
  await assert.rejects(readFile(join(directory, 'loose-old.txt')), {
    code: 'ENOENT',
  });
  await assert.rejects(readFile(join(directory, 'one/obsolete.txt')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readSkillSources(directory), [source]);
  assert.deepEqual(disposed, [1, 2]);
  await cleanStaging();
});

test('new branches sharing a prefix with the source path cannot widen the saved update scope', async (t) => {
  const { alice, install, addAmbiguousBranch } = await fixture(t);
  await install();
  addAmbiguousBranch();
  const updated = await alice.updateGroup(group);
  assert.deepEqual(
    updated.map((skill) => skill.name),
    ['one', 'two'],
  );
  assert.deepEqual(await readSkillSourceRecords(join(alice.root, group)), [
    { url: source, ref: 'feature/skills', scope: 'catalog' },
  ]);
});

test('a missing original path or an empty valid skill set leaves the original group untouched', async (t) => {
  const { alice, files, install, cleanStaging, disposed } = await fixture(t);
  await install();
  const before = await alice.read(skillPath);
  const metadata = await readFile(
    join(alice.root, group, SKILL_SOURCES_FILE),
    'utf8',
  );
  for (const path of [...files.keys()])
    if (path.startsWith('catalog/')) files.delete(path);
  await assert.rejects(alice.updateGroup(group), {
    code: 'SKILL_UPDATE_SOURCE_NOT_FOUND',
  });
  assert.deepEqual(await alice.read(skillPath), before);
  files.set('catalog/README.md', 'No skills remain');
  await assert.rejects(alice.updateGroup(group), {
    code: 'SKILL_UPDATE_EMPTY',
  });
  assert.deepEqual(await alice.read(skillPath), before);
  assert.equal(
    await readFile(join(alice.root, group, SKILL_SOURCES_FILE), 'utf8'),
    metadata,
  );
  assert.deepEqual(disposed, [1, 3]);
  await cleanStaging();
});

test('copy failure restores the entire previous group and cleans downloaded snapshots and staging', async (t) => {
  const { alice, files, install, failCopy, disposed, cleanStaging } =
    await fixture(t);
  await install();
  await writeFile(join(alice.root, group, 'keep.txt'), 'keep me');
  const before = await alice.read(skillPath);
  files.set('catalog/one/SKILL.md', manifest('one', 'Failed replacement'));
  failCopy();
  await assert.rejects(alice.updateGroup(group), /resource copy failed/);
  assert.deepEqual(await alice.read(skillPath), before);
  assert.equal(
    await readFile(join(alice.root, group, 'keep.txt'), 'utf8'),
    'keep me',
  );
  assert.equal((await alice.list()).skills.length, 1);
  assert.deepEqual(await readSkillSources(join(alice.root, group)), [source]);
  assert.deepEqual(disposed, [1, 2]);
  await cleanStaging();
});

test('legacy groups require an explicit original source and retain it for later one-click updates', async (t) => {
  const { alice, install, downloads } = await fixture(t);
  await install();
  await rm(join(alice.root, group, SKILL_SOURCES_FILE));
  await assert.rejects(alice.updateGroup(group), {
    code: 'SKILL_SOURCE_UNKNOWN',
  });
  await assert.rejects(alice.updateGroup(group, 'other/repo'), {
    code: 'SKILL_SOURCE_MISMATCH',
  });
  assert.equal(downloads.length, 1);
  const updated = await alice.updateGroup(group, source);
  assert.deepEqual(
    updated.map((skill) => skill.name),
    ['one', 'two'],
  );
  assert.deepEqual(await readSkillSources(join(alice.root, group)), [source]);
  await alice.updateGroup(group);
  assert.equal(downloads.at(-1)?.refPath, 'feature/skills/catalog');
});

test('all original import paths are retained and a missing path cancels the entire update', async (t) => {
  const { alice, files, install, cleanStaging, disposed } = await fixture(t);
  await install();
  const otherSource = 'https://github.com/owner/repo/tree/main/outside';
  await install(alice, otherSource, ['outside/other/SKILL.md']);
  files.set('outside/new/SKILL.md', manifest('new'));
  const updated = await alice.updateGroup(group);
  assert.deepEqual(updated.map((skill) => skill.name).sort(), [
    'new',
    'one',
    'other',
    'two',
  ]);
  assert.deepEqual(await readSkillSources(join(alice.root, group)), [
    source,
    otherSource,
  ]);
  const before = await alice.list();
  for (const path of [...files.keys()])
    if (path.startsWith('outside/')) files.delete(path);
  await assert.rejects(alice.updateGroup(group), {
    code: 'SKILL_UPDATE_SOURCE_NOT_FOUND',
  });
  assert.deepEqual(await alice.list(), before);
  assert.deepEqual(disposed, [1, 2, 3, 4, 5]);
  await cleanStaging();
});

test('blob sources keep the selected manifest scope when updating', async (t) => {
  const { alice, files, install } = await fixture(t);
  const blob = 'https://github.com/owner/repo/blob/main/catalog/one/SKILL.md';
  await install(alice, blob);
  files.set('catalog/one/SKILL.md', manifest('one', 'New blob instructions'));
  const updated = await alice.updateGroup(group);
  assert.deepEqual(
    updated.map((skill) => skill.name),
    ['one'],
  );
  assert.match((await alice.read(skillPath)).content, /New blob instructions/);
  files.delete('catalog/one/SKILL.md');
  await assert.rejects(alice.updateGroup(group), {
    code: 'SKILL_UPDATE_SOURCE_NOT_FOUND',
  });
});

test('personal service validates identity, ancestor symlinks, traversal and preview manifest boundaries', async (t) => {
  const { service, workspace, alice, install } = await fixture(t);
  for (const id of ['', '../bob', 'alice/other'])
    assert.throws(() => service.forUser(id));
  await mkdir(join(workspace, 'outside'));
  await symlink(join(workspace, 'outside'), join(workspace, 'users'));
  await assert.rejects(alice.list(), { code: 'SKILL_UNSAFE_PATH' });
  await rm(join(workspace, 'users'));
  await install();
  for (const path of ['../one', '/etc', 'owner/repo/../../one'])
    await assert.rejects(alice.read(path), { code: 'SKILL_UNSAFE_PATH' });
  const manifestPath = join(alice.root, skillPath, 'SKILL.md');
  await rm(manifestPath);
  await symlink(join(workspace, 'outside/secret'), manifestPath);
  await assert.rejects(alice.read(skillPath), { code: 'SKILL_NOT_FOUND' });
});

test('root local manifests can be previewed and disposing the parent releases personal scans', async (t) => {
  const { service, alice, disposed } = await fixture(t);
  await mkdir(alice.root, { recursive: true });
  await writeFile(join(alice.root, 'SKILL.md'), manifest('local'));
  assert.equal((await alice.read('')).content, manifest('local'));
  await service.forUser('bob').scan(source);
  await service.dispose();
  assert.deepEqual(disposed, [1]);
});

test('personal HTTP and RPC endpoints enforce session ownership, admin isolation and same-origin mutations', async (t) => {
  const { service, alice, install } = await fixture(t);
  await install();
  const webOrigin = 'http://localhost:5173';
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const user = headers.get('x-test-user');
        return user
          ? { user: { id: user, role: 'user' }, session: { id: user } }
          : null;
      },
    },
  } as unknown as Auth;
  const app = createApp(auth, undefined, undefined, { service, webOrigin });
  const request = (path = '/api/skills', options: RequestInit = {}) =>
    app.request(path, {
      ...options,
      headers: {
        'x-test-user': 'alice',
        origin: webOrigin,
        'content-type': 'application/json',
        ...options.headers,
      },
    });
  assert.equal((await request()).status, 200);
  assert.equal(
    (await request('/api/skills', { headers: { 'x-test-user': '' } })).status,
    401,
  );
  assert.equal((await request('/api/admin/skills')).status, 403);
  const list = await request();
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal((await list.json()).root, alice.root);
  const bob = await request('/api/skills', {
    headers: { 'x-test-user': 'bob' },
  });
  assert.deepEqual((await bob.json()).skills, []);
  assert.equal(
    (await request(`/api/skills/content?path=${skillPath}`)).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/skills/content?path=${skillPath}`, {
        headers: { 'x-test-user': 'bob' },
      })
    ).status,
    404,
  );
  for (const path of [
    '/api/skills/groups/update',
    '/api/rpc/personalSkills/updateGroup',
  ]) {
    const body = JSON.stringify(
      path.includes('/rpc/') ? { json: { body: { group } } } : { group },
    );
    assert.equal(
      (
        await request(path, {
          method: 'POST',
          body,
          headers: { origin: 'https://evil.test' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(path, {
          method: 'POST',
          body,
          headers: { 'x-test-user': 'bob' },
        })
      ).status,
      404,
    );
    assert.equal((await request(path, { method: 'POST', body })).status, 200);
  }
  assert.equal(
    (
      await request('/api/skills/groups/update', {
        method: 'POST',
        body: JSON.stringify({ group, userId: 'bob' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/api/skills', {
        method: 'DELETE',
        headers: { 'x-test-user': 'bob' },
        body: JSON.stringify({ path: skillPath }),
      })
    ).status,
    404,
  );
  assert.equal(
    (await request('/api/skills/content?path=..%2Fother')).status,
    403,
  );
});
