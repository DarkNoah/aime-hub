import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Auth } from '@aime/auth';
import type { SkillScan } from '@aime/shared/skills';
import { createApp } from '../apps/server/src/app.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import {
  parseGitHubRepository,
  readGitSnapshot,
  resolveRepositoryScope,
  type GitHubRepository,
  type RepositorySnapshot,
} from '../apps/server/src/modules/skills/github.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';

const exec = promisify(execFile);
const manifest = (name: string, description = 'Fixture description') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Original instructions\n`;
const fixtureFiles = {
  'SKILL.md': manifest('root-skill'),
  'skills/research/SKILL.md': manifest('research'),
  'skills/research/scripts/run.sh': '#!/bin/sh\necho sample\n',
  'skills/research/references/guide.md': '# Reference\n',
  'skills/research/assets/sample.bin': Buffer.from([0, 1, 255]),
  'skills/analysis/SKILL.md': manifest('Same Display Name', 'Analysis skill'),
  '.agents/skills/hidden/SKILL.md': manifest('hidden'),
  'examples/research/SKILL.md': manifest('research'),
  'broken/SKILL.md': '---\nname: broken\n---\nMissing description',
};

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'admin-skills-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  for (const [path, content] of Object.entries(fixtureFiles)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content, {
      mode: path.endsWith('.sh') ? 0o755 : 0o644,
    });
  }
  await symlink('/etc/passwd', join(repo, 'skills/research/external'));
  const git = (...args: string[]) =>
    exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo });
  await git('init', '-b', 'main');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture',
  );
  const snapshot = await readGitSnapshot(repo);
  const download = async (
    repository: GitHubRepository,
  ): Promise<RepositorySnapshot> => ({
    ...snapshot,
    ...(repository.refPath
      ? {
          ...resolveRepositoryScope(
            repository.refPath,
            `${snapshot.commit}\trefs/heads/main`,
          ),
          fileOnly: repository.kind === 'blob',
        }
      : {}),
  });
  const workspace = join(directory, 'workspace');
  const service = new SkillService(workspace, download);
  t.after(() => service.dispose());
  return { directory, repo, snapshot, download, workspace, service };
}

test('GitHub sources accept the requested forms and reject arbitrary hosts and traversal', () => {
  for (const source of [
    'wjgoarxiv/autoresearch-skill',
    'https://github.com/wjgoarxiv/autoresearch-skill',
    ' https://github.com/WJGOARXIV/autoresearch-skill.git/ ',
  ]) {
    assert.deepEqual(parseGitHubRepository(source), {
      owner: 'wjgoarxiv',
      repo: 'autoresearch-skill',
      url: 'https://github.com/wjgoarxiv/autoresearch-skill',
    });
  }
  for (const [kind, path] of [
    ['tree', 'skills'],
    ['tree', 'skills/autoresearch'],
    ['blob', 'skills/autoresearch/SKILL.md'],
  ]) {
    assert.deepEqual(
      parseGitHubRepository(
        `https://github.com/wjgoarxiv/autoresearch-skill/${kind}/main/${path}`,
      ),
      {
        owner: 'wjgoarxiv',
        repo: 'autoresearch-skill',
        url: 'https://github.com/wjgoarxiv/autoresearch-skill',
        kind,
        refPath: `main/${path}`,
      },
    );
  }
  for (const source of [
    'http://github.com/a/b',
    'https://evil.test/a/b',
    'https://github.com.evil.test/a/b',
    'https://token@github.com/a/b',
    'https://github.com:8080/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b/tree/main/../secret',
    'https://github.com/a/b/tree/main/%2Fetc/passwd',
    'https://github.com/a/b/tree/main/%00',
    'https://github.com/a/b/tree/main/%5Csecret',
    'a/.',
    'git@github.com:a/b.git',
  ])
    assert.throws(
      () => parseGitHubRepository(source),
      { code: 'SKILL_INVALID_URL' },
      source,
    );
});

test('branch/tag resolution supports slash refs, tags, and pinned commit links', () => {
  const sha = 'a'.repeat(40);
  const refs = `${sha}\trefs/heads/main\n${sha}\trefs/heads/feature\n${sha}\trefs/heads/feature/skills\n${sha}\trefs/tags/v1.0\n${sha}\trefs/tags/v1.0^{}`;
  assert.deepEqual(
    resolveRepositoryScope('feature/skills/dir/SKILL.md', refs),
    { ref: 'feature/skills', scopePath: 'dir/SKILL.md' },
  );
  assert.deepEqual(resolveRepositoryScope('v1.0/skills', refs), {
    ref: 'v1.0',
    scopePath: 'skills',
  });
  assert.deepEqual(resolveRepositoryScope(`${sha}/skills`, refs), {
    ref: sha,
    scopePath: 'skills',
  });
  assert.throws(() => resolveRepositoryScope('missing/skills', refs), {
    code: 'SKILL_SOURCE_NOT_FOUND',
  });
});

test('full and scoped scans find all manifests with stable destinations and validation', async (t) => {
  const { service, snapshot } = await fixture(t);
  const all = await service.scan('owner/repo');
  assert.equal(all.commit, snapshot.commit);
  assert.equal(all.skills.length, 6);
  assert.ok(
    all.skills.some((skill) => skill.path === '.agents/skills/hidden/SKILL.md'),
  );
  assert.equal(
    all.skills.find((skill) => skill.path === 'broken/SKILL.md')!.valid,
    false,
  );
  const research = all.skills.filter((skill) =>
    skill.path.endsWith('/research/SKILL.md'),
  );
  assert.equal(new Set(research.map((skill) => skill.name)).size, 2);
  const folder = await service.scan(
    'https://github.com/owner/repo/tree/main/skills',
  );
  assert.equal(folder.skills.length, 2);
  const file = await service.scan(
    'https://github.com/owner/repo/blob/main/skills/research/SKILL.md',
  );
  assert.equal(file.skills.length, 1);
  assert.equal(
    file.skills[0].destination,
    all.skills.find((skill) => skill.path === file.skills[0].path)!.destination,
  );
  assert.equal(file.skills[0].skippedFiles, 1);
  await assert.rejects(service.scan('owner/repo'), {
    code: 'SKILL_SCAN_LIMIT',
  });
  await service.discard(all.id);
  await assert.rejects(service.install(all.id, ['SKILL.md']), {
    code: 'SKILL_SCAN_EXPIRED',
  });
});

test('batch installation preserves bundled bytes and modes, omits links, and is visible to conversations', async (t) => {
  const { service, workspace } = await fixture(t);
  const scan = await service.scan('owner/repo');
  const selected = scan.skills.filter((skill) => skill.group === 'skills');
  const installed = await service.install(
    scan.id,
    selected.map((skill) => skill.path),
  );
  assert.equal(installed.length, 2);
  const research = installed.find((skill) =>
    skill.name.startsWith('research-'),
  )!;
  const base = join(workspace, '.agents/skills', research.path);
  assert.equal(
    await readFile(join(base, 'SKILL.md'), 'utf8'),
    fixtureFiles['skills/research/SKILL.md'],
  );
  assert.deepEqual(
    await readFile(join(base, 'assets/sample.bin')),
    Buffer.from([0, 1, 255]),
  );
  assert.ok((await stat(join(base, 'scripts/run.sh'))).mode & 0o111);
  await assert.rejects(stat(join(base, 'external')), { code: 'ENOENT' });
  assert.equal((await service.list()).skills.length, 2);
  const chat = await listChatSkills(workspace, 'alice');
  assert.deepEqual(
    chat.map((skill) => skill.name).sort(),
    installed.map((skill) => skill.name).sort(),
  );
  assert.ok(chat.every((skill) => skill.group === 'owner/repo'));
  await assert.rejects(
    service.install(
      scan.id,
      selected.map((skill) => skill.path),
    ),
    { code: 'SKILL_CONFLICT' },
  );
  assert.equal((await service.list()).skills.length, 2);
  await service.remove(research.path);
  assert.equal((await service.list()).skills.length, 1);
  await assert.rejects(service.remove(research.path), {
    code: 'SKILL_NOT_FOUND',
  });
});

test('failed batches leave no partially installed skills or staging directories', async (t) => {
  const { download, workspace } = await fixture(t);
  const service = new SkillService(workspace, async (repository) => {
    const snapshot = await download(repository);
    return {
      ...snapshot,
      read: async (file) => {
        if (file.path.endsWith('guide.md'))
          throw new Error('Fixture read failed');
        return snapshot.read(file);
      },
    };
  });
  t.after(() => service.dispose());
  const scan = await service.scan('owner/repo');
  await assert.rejects(
    service.install(scan.id, [
      'skills/analysis/SKILL.md',
      'skills/research/SKILL.md',
    ]),
    /Fixture read failed/,
  );
  assert.equal((await service.list()).skills.length, 0);
  assert.deepEqual(await readdir(join(workspace, '.agents')), ['skills']);
});

test('root and nested skills install as independent packages without discovering bundled manifests twice', async (t) => {
  const { service, workspace } = await fixture(t);
  const scan = await service.scan('owner/repo');
  await service.install(scan.id, ['SKILL.md', 'skills/analysis/SKILL.md']);
  assert.deepEqual(
    (await service.list()).skills.map((skill) => skill.name).sort(),
    ['analysis', 'root-skill'],
  );
  assert.deepEqual(
    (await listChatSkills(workspace, 'alice'))
      .map((skill) => skill.name)
      .sort(),
    ['analysis', 'root-skill'],
  );
  assert.equal(
    await readFile(
      join(service.root, 'owner/repo/root-skill/skills/analysis/SKILL.md'),
      'utf8',
    ),
    fixtureFiles['skills/analysis/SKILL.md'],
  );
});

test('cancelled scans dispose their snapshot and release scan capacity', async (t) => {
  const { workspace, snapshot } = await fixture(t);
  let disposed = 0;
  const service = new SkillService(workspace, async () => ({
    ...snapshot,
    dispose: async () => {
      disposed++;
    },
  }));
  t.after(() => service.dispose());
  const controller = new AbortController();
  controller.abort();
  for (let i = 0; i < 4; i++) {
    await assert.rejects(service.scan('owner/repo', controller.signal), {
      code: 'SKILL_DOWNLOAD_FAILED',
    });
  }
  assert.equal(disposed, 4);
  const scan = await service.scan('owner/repo');
  await service.discard(scan.id);
  assert.equal(disposed, 5);
});

test('mutation validation rejects unknown skills, invalid manifests, directory traversal and symlink roots', async (t) => {
  const { service, workspace, directory } = await fixture(t);
  const scan = await service.scan('owner/repo');
  for (const path of ['missing/SKILL.md', '../SKILL.md', 'broken/SKILL.md'])
    await assert.rejects(service.install(scan.id, [path]), {
      code: 'SKILL_INVALID_SELECTION',
    });
  for (const path of [
    '',
    '../escape',
    '/absolute',
    'owner/../../escape',
    'owner\\repo',
  ])
    await assert.rejects(service.remove(path), { code: 'SKILL_UNSAFE_PATH' });
  await mkdir(workspace, { recursive: true });
  await symlink(directory, join(workspace, '.agents'));
  await assert.rejects(service.list(), { code: 'SKILL_UNSAFE_PATH' });
  await assert.rejects(service.install(scan.id, ['skills/analysis/SKILL.md']), {
    code: 'SKILL_UNSAFE_PATH',
  });
});

test('concurrent installs do not overwrite and existing ancestor skills remain intact', async (t) => {
  const { service, workspace } = await fixture(t);
  const scan = await service.scan('owner/repo');
  const outcomes = await Promise.allSettled(
    [1, 2].map(() => service.install(scan.id, ['skills/analysis/SKILL.md'])),
  );
  assert.equal(
    outcomes.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    outcomes.filter((result) => result.status === 'rejected').length,
    1,
  );
  await writeFile(
    join(workspace, '.agents/skills/owner/SKILL.md'),
    manifest('owner'),
  );
  await assert.rejects(service.install(scan.id, ['SKILL.md']), {
    code: 'SKILL_CONFLICT',
  });
  assert.equal(
    await readFile(join(workspace, '.agents/skills/owner/SKILL.md'), 'utf8'),
    manifest('owner'),
  );
});

test('admin skills API enforces session, role, same-origin and selection validation', async (t) => {
  const { service } = await fixture(t);
  const webOrigin = 'http://localhost:5173';
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const role = headers.get('x-test-role');
        return role
          ? { user: { id: 'fixture', role }, session: { id: 'fixture' } }
          : null;
      },
    },
  } as unknown as Auth;
  const server = createApp(auth, undefined, undefined, {
    service,
    webOrigin,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = (path = '', options: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}/api/admin/skills${path}`, {
      ...options,
      headers: {
        'x-test-role': 'admin',
        origin: webOrigin,
        'content-type': 'application/json',
        ...options.headers,
      },
    });
  assert.equal(
    (await request('', { headers: { 'x-test-role': '' } })).status,
    401,
  );
  assert.equal(
    (await request('', { headers: { 'x-test-role': 'user' } })).status,
    403,
  );
  assert.equal(
    (
      await request('/scans', {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        body: JSON.stringify({ url: 'owner/repo' }),
      })
    ).status,
    403,
  );
  const list = await request();
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal(list.status, 200);
  assert.equal(
    (await request('/scans', { method: 'POST', body: '{}' })).status,
    400,
  );
  const scanResponse = await request('/scans', {
    method: 'POST',
    body: JSON.stringify({ url: 'owner/repo' }),
  });
  assert.equal(scanResponse.status, 200);
  const scan = (await scanResponse.json()) as SkillScan;
  const installed = await request('/install', {
    method: 'POST',
    body: JSON.stringify({
      scanId: scan.id,
      paths: ['skills/analysis/SKILL.md'],
    }),
  });
  assert.equal(installed.status, 201);
  const result = (await installed.json()) as { path: string }[];
  assert.equal(
    (
      await request('', {
        method: 'DELETE',
        body: JSON.stringify({ path: result[0].path }),
      })
    ).status,
    204,
  );
  const batch = await request('/install', {
    method: 'POST',
    body: JSON.stringify({
      scanId: scan.id,
      paths: ['skills/analysis/SKILL.md', 'skills/research/SKILL.md'],
    }),
  });
  assert.equal(batch.status, 201);
  const batchPaths = ((await batch.json()) as { path: string }[]).map(
    (skill) => skill.path,
  );
  const groupBody = JSON.stringify({ group: 'owner/repo', paths: batchPaths });
  for (const [headers, status] of [
    [{ 'x-test-role': '' }, 401],
    [{ 'x-test-role': 'user' }, 403],
    [{ origin: 'https://evil.test' }, 403],
  ] as const) {
    assert.equal(
      (await request('/groups', { method: 'DELETE', headers, body: groupBody }))
        .status,
      status,
    );
  }
  assert.equal(
    (
      await request('/groups', {
        method: 'DELETE',
        body: JSON.stringify({ group: '', paths: batchPaths }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/groups', {
        method: 'DELETE',
        body: JSON.stringify({
          group: 'owner/repo',
          paths: batchPaths.slice(0, 1),
        }),
      })
    ).status,
    409,
  );
  const deletedGroup = await request('/groups', {
    method: 'DELETE',
    body: groupBody,
  });
  assert.equal(deletedGroup.status, 200);
  assert.deepEqual(
    ((await deletedGroup.json()) as string[]).sort(),
    batchPaths.sort(),
  );
  await assert.rejects(stat(join(service.root, 'owner/repo')), {
    code: 'ENOENT',
  });
  assert.equal(
    (await request(`/scans/${scan.id}`, { method: 'DELETE' })).status,
    204,
  );
  assert.equal(
    (
      await request('/install', {
        method: 'POST',
        body: JSON.stringify({ scanId: scan.id, paths: ['SKILL.md'] }),
      })
    ).status,
    410,
  );
});

test('group removal deletes exactly the confirmed group and preserves adjacent groups and loose files', async (t) => {
  const { service, workspace } = await fixture(t);
  const scan = await service.scan('owner/repo');
  const installed = await service.install(scan.id, [
    'skills/analysis/SKILL.md',
    'skills/research/SKILL.md',
  ]);
  for (const path of [
    'owner/repo/nested/keep',
    'owner/repository/keep',
    'local',
  ]) {
    await mkdir(join(service.root, path), { recursive: true });
    await writeFile(join(service.root, path, 'SKILL.md'), manifest('keep'));
  }
  await writeFile(
    join(service.root, 'owner/repo/README.md'),
    'Keep loose files',
  );
  const expected = installed.map((skill) => skill.path);
  await assert.rejects(
    service.removeGroup('owner/repo', expected.slice(0, 1)),
    { code: 'SKILL_GROUP_CHANGED' },
  );
  await assert.rejects(
    service.removeGroup('owner/repo', [...expected, 'owner/repository/keep']),
    { code: 'SKILL_GROUP_CHANGED' },
  );
  assert.equal((await service.list()).skills.length, 5);
  for (const group of ['', '..', '../outside', '/absolute', 'owner\\repo'])
    await assert.rejects(service.removeGroup(group, expected), {
      code: 'SKILL_UNSAFE_PATH',
    });
  assert.deepEqual(
    (await service.removeGroup('owner/repo', expected)).sort(),
    expected.sort(),
  );
  assert.deepEqual(
    (await service.list()).skills.map((skill) => skill.path).sort(),
    ['local', 'owner/repo/nested/keep', 'owner/repository/keep'],
  );
  assert.equal(
    await readFile(join(service.root, 'owner/repo/README.md'), 'utf8'),
    'Keep loose files',
  );
  assert.deepEqual(await readdir(join(workspace, '.agents')), ['skills']);
  await assert.rejects(service.removeGroup('owner/repo', expected), {
    code: 'SKILL_NOT_FOUND',
  });
});

test('group removal rejects a symlink group without deleting any targets', async (t) => {
  const { service } = await fixture(t);
  const scan = await service.scan('owner/repo');
  const installed = await service.install(scan.id, [
    'skills/analysis/SKILL.md',
  ]);
  await symlink(join(service.root, 'owner/repo'), join(service.root, 'linked'));
  await assert.rejects(
    service.removeGroup(
      'linked',
      installed.map((skill) => skill.path),
    ),
    { code: 'SKILL_UNSAFE_PATH' },
  );
  assert.equal((await service.list()).skills.length, 1);
});
