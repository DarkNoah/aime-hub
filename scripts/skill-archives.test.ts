import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Auth } from '@aime/auth';
import { SKILL_ARCHIVE_MAX_UNPACKED_BYTES } from '@aime/shared/skills';
import { createApp } from '../apps/server/src/app.js';
import { readSkillArchive } from '../apps/server/src/modules/skills/archive.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import {
  readSkillArchiveGroup,
  readSkillProject,
  SKILL_ARCHIVE_FILE,
  SKILL_META_DIRECTORY,
  SKILL_PROJECT_FILE,
} from '../apps/server/src/modules/skills/project.js';
import {
  migrateSkillOriginUnits,
  SkillOrigins,
} from '../apps/server/src/modules/skills/origins.js';
import { projectSharedSkillsRoot } from '../apps/server/src/modules/skills/share-links.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';

const { zipSync } = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
)('fflate') as {
  zipSync(
    files: Record<
      string,
      Uint8Array | [Uint8Array, { attrs: number; os: number }]
    >,
    options?: { level: number },
  ): Uint8Array;
};
const manifest = (name: string) =>
  `---\nname: ${name}\ndescription: Archive fixture\n---\nUse bundled resources.\n`;
const zip = (files: Record<string, string | Buffer>, level = 6) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, value]) => [
          path,
          Buffer.from(value),
        ]),
      ),
      { level },
    ),
  );
const central = (data: Buffer) =>
  data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'skill-archives-test-'));
  const downloads = join(root, 'downloads');
  const originalTmp = process.env.TMPDIR;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(downloads);
  process.env.TMPDIR = downloads;
  const service = new SkillService(join(root, 'workspace'));
  t.after(async () => {
    await service.dispose();
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    service,
    clean: async () => assert.deepEqual(await readdir(downloads), []),
  };
}

test('zip and skill archives install complete packages and binary resources without Git source metadata', async (t) => {
  const f = await fixture(t);
  const data = Buffer.from(
    zipSync({
      'SKILL.md': Buffer.from(manifest('complete-package')),
      'assets/图片.bin': Buffer.from([0, 255, 1, 128]),
      'scripts/run.sh': [
        Buffer.from('#!/bin/sh\nexit 0\n'),
        { attrs: (0o100755 << 16) >>> 0, os: 3 },
      ],
      'skills/nested/SKILL.md': Buffer.from(manifest('nested')),
      '.git/config': Buffer.from('ignored'),
      '__MACOSX/._SKILL.md': Buffer.from('ignored'),
      '.DS_Store': Buffer.from('ignored'),
    }),
  );
  for (const filename of ['Bundle.zip', 'Bundle.SKILL']) {
    const target = filename.endsWith('zip')
      ? f.service
      : f.service.forUser('alice');
    const scan = await target.scanArchive(filename, data);
    assert.equal(scan.sourceType, 'archive');
    assert.equal(scan.filename, filename);
    assert.equal(scan.url, '');
    assert.equal(scan.skills.length, 1);
    assert.equal(scan.skills[0].name, 'complete-package');
    assert.deepEqual(scan.skills[0].bundledSkills, ['skills/nested/SKILL.md']);
    const installed = await target.install(scan.id, ['SKILL.md']);
    assert.equal(installed[0].path, 'bundle/complete-package');
    assert.equal(installed[0].group, 'bundle');
    assert.equal(installed[0].sourceType, 'archive');
    const directory = join(target.root, installed[0].path);
    assert.deepEqual(
      await readFile(join(directory, 'assets/图片.bin')),
      Buffer.from([0, 255, 1, 128]),
    );
    assert.equal(
      (await stat(join(directory, 'scripts/run.sh'))).mode & 0o777,
      0o755,
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      'SKILL.md',
      'assets',
      'scripts',
      'skills',
    ]);
    assert.deepEqual((await readdir(join(target.root, 'bundle'))).sort(), [
      SKILL_META_DIRECTORY,
      'complete-package',
    ]);
    assert.equal(
      await readSkillArchiveGroup(join(target.root, 'bundle')),
      true,
    );
    await assert.rejects(target.updateGroup('bundle'), {
      code: 'SKILL_SOURCE_UNKNOWN',
    });
  }
  assert.equal(
    (await listChatSkills(join(f.root, 'workspace'), 'alice')).length,
    1,
  );
  await f.clean();
});

test('wrapped collections support selected installs, conflicts and owner-scoped scan ids', async (t) => {
  const f = await fixture(t);
  const data = zip({
    'wrapper/alpha/SKILL.md': manifest('alpha'),
    'wrapper/alpha/guide.txt': 'guide',
    'wrapper/beta/SKILL.md': manifest('beta'),
  });
  const alice = f.service.forUser('alice');
  const bob = f.service.forUser('bob');
  const scan = await alice.scanArchive('collection.skill', data);
  assert.deepEqual(
    scan.skills.map((skill) => skill.path),
    ['wrapper/alpha/SKILL.md', 'wrapper/beta/SKILL.md'],
  );
  await assert.rejects(bob.install(scan.id, [scan.skills[0].path]), {
    code: 'SKILL_SCAN_EXPIRED',
  });
  await alice.install(scan.id, [scan.skills[0].path]);
  const second = await alice.scanArchive('collection.zip', data);
  assert.deepEqual(
    second.skills.map((skill) => skill.installed),
    [true, false],
  );
  await assert.rejects(
    alice.install(
      second.id,
      second.skills.map((skill) => skill.path),
    ),
    { code: 'SKILL_CONFLICT' },
  );
  assert.deepEqual(
    (await alice.list()).skills.map((skill) => skill.name),
    ['alpha'],
  );
  assert.deepEqual((await bob.list()).skills, []);
  const discarded = await alice.scanArchive('collection.zip', data);
  await alice.discard(discarded.id);
  await assert.rejects(
    alice.install(discarded.id, [discarded.skills[0].path]),
    { code: 'SKILL_SCAN_EXPIRED' },
  );
  await f.clean();
});

test('archive containers preserve package metadata resources through runtime, sharing and final cleanup', async (t) => {
  const f = await fixture(t);
  const alice = f.service.forUser('alice');
  const scan = await alice.scanArchive(
    'resources.zip',
    zip({
      'SKILL.md': manifest('resources'),
      '.skill-meta/config.txt': 'upstream resource',
      '.skill-project.json': 'upstream root marker',
      '.skill-sources.json': 'upstream source marker',
    }),
  );
  const [installed] = await alice.install(scan.id, ['SKILL.md']);
  assert.equal(installed.path, 'resources/resources');
  assert.equal((await alice.list()).skills[0]?.sourceType, 'archive');
  const workspace = join(f.root, 'workspace');
  assert.equal(
    (await listChatSkills(workspace, 'alice'))[0]?.name,
    'resources',
  );
  for (const target of [
    { scope: 'global' } as const,
    { scope: 'project', projectId: 'project000000001' } as const,
  ]) {
    const [shared] = await f.service.sharePersonal(
      'alice',
      installed.path,
      target,
    );
    assert.equal(shared.sourceType, 'archive');
    const service =
      target.scope === 'global'
        ? f.service
        : f.service.forProject(target.projectId);
    const store =
      target.scope === 'global'
        ? service.root
        : projectSharedSkillsRoot(workspace, target.projectId);
    assert.equal(await readSkillArchiveGroup(join(store, 'resources')), true);
    const [listed] = (await service.list()).skills;
    assert.equal(listed?.sourceType, 'archive');
    assert.equal(listed?.group, 'resources');
    assert.equal(
      (
        await listChatSkills(
          workspace,
          'bob',
          target.scope === 'project' ? target.projectId : undefined,
        )
      )[0]?.name,
      'resources',
    );
    await f.service.unsharePersonal('alice', installed.path, target);
    await assert.rejects(stat(join(store, 'resources')), { code: 'ENOENT' });
  }
  assert.equal(
    await readFile(
      join(alice.root, installed.path, '.skill-meta/config.txt'),
      'utf8',
    ),
    'upstream resource',
  );
  await alice.remove(installed.path);
  await assert.rejects(stat(join(alice.root, 'resources')), { code: 'ENOENT' });
});

test('ordinary archive groups reject owner and project collisions and malformed management markers', async (t) => {
  const f = await fixture(t);
  const data = zip({ 'SKILL.md': manifest('package') });
  for (const name of ['plugins', 'builtin']) {
    await assert.rejects(f.service.scanArchive(`${name}.zip`, data), {
      code: 'SKILL_UNSAFE_PATH',
    });
  }
  const occupied = join(f.service.root, 'owner/repo/package');
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, 'SKILL.md'), manifest('package'));
  await assert.rejects(f.service.scanArchive('owner.zip', data), {
    code: 'SKILL_CONFLICT',
  });
  const project = await f.service.scanArchive(
    'project.zip',
    data,
    undefined,
    'project',
  );
  await f.service.install(project.id, ['SKILL.md']);
  await assert.rejects(f.service.scanArchive('project.zip', data), {
    code: 'SKILL_CONFLICT',
  });
  const scan = await f.service.scanArchive('archive.zip', data);
  await f.service.install(scan.id, ['SKILL.md']);
  const meta = join(f.service.root, 'archive', SKILL_META_DIRECTORY);
  assert.equal(await readSkillProject(dirname(meta)), undefined);
  await writeFile(join(meta, SKILL_PROJECT_FILE), '{}');
  await assert.rejects(readSkillArchiveGroup(dirname(meta)), {
    code: 'SKILL_PROJECT_INVALID',
  });
  await assert.rejects(f.service.scanArchive('archive.zip', data), {
    code: 'SKILL_PROJECT_INVALID',
  });
  await rm(join(meta, SKILL_PROJECT_FILE));
  await writeFile(join(meta, SKILL_ARCHIVE_FILE), '{"version":2}');
  await assert.rejects(f.service.list(), { code: 'SKILL_PROJECT_INVALID' });
});

test('unmigrated archive remnants block scans and cached installs without creating duplicate groups', async (t) => {
  const f = await fixture(t);
  const data = zip({ 'SKILL.md': manifest('package') });
  const cached = await f.service.scanArchive('legacy.zip', data);
  const old = join(f.service.root, '@local/legacy/package');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'SKILL.md'), manifest('package'));
  for (const mode of ['skills', 'project'] as const)
    await assert.rejects(
      f.service.scanArchive('legacy.zip', data, undefined, mode),
      { code: 'SKILL_CONFLICT' },
    );
  await assert.rejects(f.service.install(cached.id, ['SKILL.md']), {
    code: 'SKILL_CONFLICT',
  });
  await assert.rejects(stat(join(f.service.root, 'legacy')), {
    code: 'ENOENT',
  });
  await symlink(old, join(f.service.root, '@local/linked'), 'dir');
  await assert.rejects(f.service.scanArchive('linked.zip', data), {
    code: 'SKILL_CONFLICT',
  });
  await mkdir(join(f.service.root, '.@local.skill-install.lock'));
  await assert.rejects(f.service.scanArchive('fresh.zip', data), {
    code: 'SKILL_CONFLICT',
  });
  await f.clean();
});

test('failed archive publication restores empty groups and rolls back added packages without removing existing entries', async (t) => {
  const f = await fixture(t);
  const data = zip({
    'alpha/SKILL.md': manifest('alpha'),
    'beta/SKILL.md': manifest('beta'),
    'existing/SKILL.md': manifest('existing'),
  });
  const group = join(f.service.root, 'atomic');
  await mkdir(group, { recursive: true });
  const rename = fs.rename;
  let fail = group;
  fs.rename = async (from, to) => {
    if (String(to) === fail) throw new Error('publication failure');
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    let scan = await f.service.scanArchive('atomic.zip', data);
    await assert.rejects(
      f.service.install(scan.id, ['alpha/SKILL.md']),
      /publication failure/,
    );
    assert.deepEqual(await readdir(group), []);
    fail = '';
    scan = await f.service.scanArchive('atomic.zip', data);
    await f.service.install(scan.id, ['existing/SKILL.md']);
    fail = join(group, 'beta');
    scan = await f.service.scanArchive('atomic.zip', data);
    await assert.rejects(
      f.service.install(scan.id, ['alpha/SKILL.md', 'beta/SKILL.md']),
      /publication failure/,
    );
    assert.deepEqual(
      (await f.service.list()).skills.map((skill) => skill.path),
      ['atomic/existing'],
    );
    assert.deepEqual((await readdir(group)).sort(), [
      SKILL_META_DIRECTORY,
      'existing',
    ]);
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  await f.clean();
});

test('archive provenance migration is retryable and preserves withdrawal ownership at its new path', async (t) => {
  const f = await fixture(t);
  const workspace = join(f.root, 'workspace');
  const old = '@local/archive/package';
  const path = 'archive/package';
  const scan = await f.service.scanArchive(
    'archive.zip',
    zip({ 'SKILL.md': manifest('package') }),
  );
  await f.service.install(scan.id, ['SKILL.md']);
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const key = (unit: string) => hash(JSON.stringify(['global', unit]));
  const registry = join(workspace, '.agents/skill-origins');
  await mkdir(registry, { recursive: true });
  const token = randomUUID();
  const sharing = {
    scope: 'global',
    userId: 'alice',
    userName: 'Alice',
  } as const;
  const record = (unit: string) =>
    join(registry, `${key(unit)}.${hash('alice')}.json`);
  const marker = (unit: string) =>
    join(f.service.root, path, `.skill-origin-${key(unit)}`);
  await writeFile(record(old), JSON.stringify({ sharing, unit: old, token }));
  await writeFile(marker(old), token);
  const moves = new Map([[old, path]]);
  // A process can stop after the new token is written and before deleting the old record.
  await writeFile(marker(path), token);
  for (let retry = 0; retry < 2; retry++)
    await migrateSkillOriginUnits(
      workspace,
      { scope: 'global' },
      f.service.root,
      moves,
    );
  await assert.rejects(stat(record(old)), { code: 'ENOENT' });
  await assert.rejects(stat(marker(old)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(record(path), 'utf8')).unit, path);
  const [restored] = await new SkillOrigins(f.service.root).restore(
    f.service,
    path,
    sharing,
  );
  assert.equal(restored.sourceType, 'archive');
  assert.equal(
    await readSkillArchiveGroup(
      join(f.service.forUser('alice').root, 'archive'),
    ),
    true,
  );
  await assert.rejects(stat(join(f.service.root, 'archive')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readdir(registry), []);
});

test('legacy CP437 ZIP filenames preserve non-ASCII bundled resources', async (t) => {
  const f = await fixture(t);
  const data = zip({
    'SKILL.md': manifest('legacy'),
    'cafe.txt': 'café resource',
  });
  // Keep filename lengths unchanged while encoding e-acute as the CP437 byte 0x82.
  let cursor = 0;
  for (const signature of [0x04034b50, 0x02014b50]) {
    cursor = 0;
    while (
      (cursor = data.indexOf(
        Buffer.from(
          signature === 0x04034b50
            ? [0x50, 0x4b, 0x03, 0x04]
            : [0x50, 0x4b, 0x01, 0x02],
        ),
        cursor,
      )) >= 0
    ) {
      const name = cursor + (signature === 0x04034b50 ? 30 : 46);
      if (data.subarray(name, name + 8).toString() === 'cafe.txt') {
        data[name + 3] = 0x82;
        const flagOffset = cursor + (signature === 0x04034b50 ? 6 : 8);
        data.writeUInt16LE(data.readUInt16LE(flagOffset) & ~0x0800, flagOffset);
      }
      cursor++;
    }
  }
  const scan = await f.service.scanArchive('legacy.skill', data);
  await f.service.install(scan.id, ['SKILL.md']);
  assert.equal(
    await readFile(join(f.service.root, 'legacy/legacy/café.txt'), 'utf8'),
    'café resource',
  );
  await f.clean();
});

test('archive validation rejects traversal, ambiguous paths, symlinks and special files before writing', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '../escape',
    '/absolute',
    'C:/drive',
    'folder\\file',
    'a/../../escape',
    'a/./file',
    'a//file',
    'a/evil\0.txt',
  ]) {
    await assert.rejects(
      f.service.scanArchive(
        'unsafe.zip',
        zip({ 'SKILL.md': manifest('safe'), [path]: 'bad' }),
      ),
      { code: 'SKILL_ARCHIVE_UNSAFE' },
    );
  }
  for (const files of [
    { 'A.txt': 'one', 'a.txt': 'two' },
    { 'Foo/a.txt': 'one', 'foo/b.txt': 'two' },
    { item: 'file', 'item/child.txt': 'child' },
  ] as Record<string, string>[]) {
    await assert.rejects(
      f.service.scanArchive(
        'unsafe.zip',
        zip({ 'SKILL.md': manifest('safe'), ...files }),
      ),
      { code: 'SKILL_ARCHIVE_UNSAFE' },
    );
  }
  for (const mode of [0o120777, 0o020666]) {
    const data = zip({ 'SKILL.md': manifest('safe') });
    data.writeUInt32LE((mode << 16) >>> 0, central(data) + 38);
    await assert.rejects(f.service.scanArchive('unsafe.skill', data), {
      code: 'SKILL_ARCHIVE_UNSAFE',
    });
  }
  await f.clean();
});

test('archive validation rejects malformed content, encrypted entries, checksum failures and expansion abuse', async (t) => {
  const f = await fixture(t);
  for (const [filename, data] of [
    ['invalid.txt', zip({ 'SKILL.md': manifest('safe') })],
    ['invalid.zip', Buffer.from('not a zip')],
    ['empty.zip', zip({ 'README.md': 'no skill' })],
    ['truncated.zip', zip({ 'SKILL.md': manifest('safe') }).subarray(0, -2)],
  ] as const)
    await assert.rejects(f.service.scanArchive(filename, data), {
      code: 'SKILL_ARCHIVE_INVALID',
    });
  for (const mutation of [
    'encrypted',
    'method',
    'checksum',
    'oversized',
    'actual-size',
    'overlap',
  ] as const) {
    const data = zip({ 'SKILL.md': manifest('safe') }, 0);
    const offset = central(data);
    if (mutation === 'encrypted') data.writeUInt16LE(1, offset + 8);
    if (mutation === 'method') data.writeUInt16LE(99, offset + 10);
    if (mutation === 'checksum') data[30 + data.readUInt16LE(26)] ^= 0xff;
    if (mutation === 'oversized')
      data.writeUInt32LE(SKILL_ARCHIVE_MAX_UNPACKED_BYTES + 1, offset + 24);
    if (mutation === 'actual-size') {
      data.writeUInt32LE(1, offset + 24);
      data.writeUInt32LE(1, 22);
    }
    if (mutation === 'overlap') data.writeUInt32LE(offset + 1, offset + 42);
    await assert.rejects(f.service.scanArchive('invalid.skill', data), {
      code:
        mutation === 'oversized'
          ? 'SKILL_ARCHIVE_TOO_LARGE'
          : 'SKILL_ARCHIVE_INVALID',
    });
    await f.clean();
  }
});

test('cancellation and invalid selected manifests release temporary snapshots', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.service.scanArchive(
      'valid.zip',
      zip({ 'SKILL.md': manifest('valid') }),
      controller.signal,
    ),
    { code: 'ABORTED' },
  );
  const scan = await f.service.scanArchive(
    'invalid.zip',
    zip({ 'SKILL.md': '# Missing metadata' }),
  );
  assert.equal(scan.skills[0].valid, false);
  await assert.rejects(f.service.install(scan.id, ['SKILL.md']), {
    code: 'SKILL_INVALID_SELECTION',
  });
  await f.clean();
  // A decompression failure must also clean resources already materialized.
  const data = zip(
    { 'resource.txt': 'kept only temporarily', 'SKILL.md': manifest('valid') },
    0,
  );
  let last = data.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
  assert.ok(last > 0);
  last += 30 + data.readUInt16LE(last + 26);
  data[last] ^= 0xff;
  await assert.rejects(readSkillArchive('invalid.zip', data), {
    code: 'SKILL_ARCHIVE_INVALID',
  });
  await f.clean();
});

test('archive upload APIs enforce authentication, scope, origin and input validation', async (t) => {
  const f = await fixture(t);
  const webOrigin = 'http://localhost:5173';
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return id
          ? { user: { id, role: id === 'admin' ? 'admin' : 'user' } }
          : null;
      },
    },
  } as unknown as Auth;
  const app = createApp(auth, undefined, undefined, {
    service: f.service,
    webOrigin,
  });
  const upload = (
    scope: 'admin/skills' | 'skills',
    user = 'alice',
    origin = webOrigin,
    filename = 'upload.skill',
    data = zip({ 'SKILL.md': manifest('uploaded') }),
  ) => {
    const body = new FormData();
    body.set(
      'file',
      new File([new Uint8Array(data)], filename, {
        type: 'application/octet-stream',
      }),
    );
    return app.request(`/api/${scope}/archives`, {
      method: 'POST',
      body,
      headers: { origin, 'x-test-user': user },
    });
  };
  assert.equal((await upload('skills', '')).status, 401);
  assert.equal((await upload('admin/skills')).status, 403);
  assert.equal(
    (await upload('skills', 'alice', 'https://evil.test')).status,
    403,
  );
  assert.equal((await upload('admin/skills', 'admin', '')).status, 403);
  assert.equal(
    (await upload('skills', 'alice', webOrigin, 'bad.txt')).status,
    400,
  );
  assert.equal(
    (
      await app.request('/api/skills/archives', {
        method: 'POST',
        body: '{}',
        headers: {
          origin: webOrigin,
          'x-test-user': 'alice',
          'content-type': 'application/json',
        },
      })
    ).status,
    400,
  );
  for (const scope of ['skills', 'admin/skills'] as const) {
    const response = await upload(
      scope,
      scope === 'skills' ? 'alice' : 'admin',
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const scan = await response.json();
    const target = scope === 'skills' ? f.service.forUser('alice') : f.service;
    assert.equal(scan.sourceType, 'archive');
    await assert.rejects(
      f.service.forUser('bob').install(scan.id, ['SKILL.md']),
      { code: 'SKILL_SCAN_EXPIRED' },
    );
    await target.install(scan.id, ['SKILL.md']);
  }
  // Adding the multipart routes must not force Origin onto existing read-only APIs.
  assert.equal(
    (await app.request('/api/skills', { headers: { 'x-test-user': 'alice' } }))
      .status,
    200,
  );
  await f.clean();
});
