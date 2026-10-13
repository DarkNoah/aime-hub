import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import {
  readSkillSources,
  SKILL_SOURCES_FILE,
} from '../apps/server/src/modules/skills/sources.js';
import {
  resolveRepositoryScope,
  type RepositorySnapshot,
} from '../apps/server/src/modules/skills/github.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';

const manifest = (name: string) =>
  `---\nname: ${name}\ndescription: Package fixture\n---\nRead scripts/shared.py and skills/plan/SKILL.md.\n`;
const url = 'https://github.com/owner/repo';

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'skill-packages-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const files = new Map([
    ['SKILL.md', manifest('complete-package')],
    ['skills/plan/SKILL.md', manifest('plan')],
    ['skills/debug/SKILL.md', manifest('debug')],
    ['scripts/shared.py', '# shared script'],
    ['assets/template.md', '# shared template'],
  ]);
  let failCopy = false;
  const service = new SkillService(
    workspace,
    async (repository, _signal, original): Promise<RepositorySnapshot> => {
      const snapshot = new Map(files);
      return {
        commit: 'a'.repeat(40),
        ...(original
          ? { scopePath: original.scope, ref: original.ref ?? undefined }
          : repository.refPath
            ? resolveRepositoryScope(
                repository.refPath,
                `${'a'.repeat(40)}\trefs/heads/main`,
              )
            : {}),
        fileOnly: repository.kind === 'blob',
        files: [...snapshot].map(([path, content]) => ({
          path,
          oid: path,
          mode: '100644',
          size: Buffer.byteLength(content),
        })),
        read: async (file) => {
          if (failCopy && file.path.endsWith('.py'))
            throw new Error('copy failure');
          return Buffer.from(snapshot.get(file.path)!);
        },
        dispose: async () => {},
      };
    },
  );
  t.after(() => service.dispose());
  const install = async (source = url, paths = ['SKILL.md']) => {
    const scan = await service.scan(source);
    return service.install(scan.id, paths);
  };
  return {
    workspace,
    files,
    service,
    install,
    failCopy: () => {
      failCopy = true;
    },
  };
}

test('root packages retain shared resources, internal entries and their installation mode across updates', async (t) => {
  const { workspace, files, service, install } = await fixture(t);
  const scan = await service.scan(url);
  assert.deepEqual(
    scan.skills.map((skill) => skill.path),
    ['SKILL.md'],
  );
  assert.deepEqual(scan.skills[0].bundledSkills, [
    'skills/plan/SKILL.md',
    'skills/debug/SKILL.md',
  ]);
  await assert.rejects(service.install(scan.id, ['skills/plan/SKILL.md']), {
    code: 'SKILL_INVALID_SELECTION',
  });
  const [installed] = await install();
  const group = join(service.root, 'owner/repo');
  const target = join(service.root, installed.path);
  assert.equal(
    await readFile(join(target, 'scripts/shared.py'), 'utf8'),
    '# shared script',
  );
  assert.equal(
    await readFile(join(target, 'assets/template.md'), 'utf8'),
    '# shared template',
  );
  assert.equal((await listChatSkills(workspace, 'alice')).length, 1);
  assert.deepEqual((await readSkillSources(group))[0].installation, {
    mode: 'package',
    path: 'SKILL.md',
    name: 'complete-package',
  });
  files.set('SKILL.md', manifest('renamed-upstream'));
  files.set('skills/new/SKILL.md', manifest('new'));
  files.set('scripts/shared.py', '# updated script');
  files.delete('assets/template.md');
  for (let i = 0; i < 2; i++) {
    const updated = await service.updateGroup('owner/repo');
    assert.deepEqual(
      updated.map((skill) => skill.path),
      [installed.path],
    );
    assert.deepEqual((await readdir(group)).sort(), [
      SKILL_SOURCES_FILE,
      'complete-package',
    ]);
    assert.equal(
      await readFile(join(target, 'scripts/shared.py'), 'utf8'),
      '# updated script',
    );
    assert.equal(
      await readFile(join(target, 'skills/new/SKILL.md'), 'utf8'),
      manifest('new'),
    );
    await assert.rejects(readFile(join(target, 'assets/template.md')), {
      code: 'ENOENT',
    });
  }
});

test('invalid or missing package entries never fall back to installing child skills', async (t) => {
  const { files, service, install } = await fixture(t);
  await install();
  const before = await service.list();
  files.set('SKILL.md', 'invalid manifest');
  const scan = await service.scan(url);
  assert.equal(scan.skills.length, 1);
  assert.equal(scan.skills[0].valid, false);
  await service.discard(scan.id);
  await assert.rejects(service.updateGroup('owner/repo'), {
    code: 'SKILL_UPDATE_EMPTY',
  });
  files.delete('SKILL.md');
  await assert.rejects(service.updateGroup('owner/repo'), {
    code: 'SKILL_UPDATE_SOURCE_NOT_FOUND',
  });
  assert.deepEqual(await service.list(), before);
});

test('collections keep their mode when upstream adds a root entry and respect nested package boundaries', async (t) => {
  const { files, service, install } = await fixture(t);
  files.delete('SKILL.md');
  files.set('skills/plan/internal/SKILL.md', manifest('internal'));
  await install(url, ['skills/plan/SKILL.md']);
  files.set('SKILL.md', manifest('complete-package'));
  const updated = await service.updateGroup('owner/repo');
  assert.deepEqual(updated.map((skill) => skill.name).sort(), [
    'debug',
    'plan',
  ]);
  assert.deepEqual(
    (await readSkillSources(join(service.root, 'owner/repo')))[0].installation,
    { mode: 'collection' },
  );
  assert.equal(
    await readFile(
      join(service.root, 'owner/repo/plan/internal/SKILL.md'),
      'utf8',
    ),
    manifest('internal'),
  );
});

test('explicit scoped sources keep their scope and nested packages on update', async (t) => {
  const { files, service, install } = await fixture(t);
  files.set('skills/plan/internal/SKILL.md', manifest('internal'));
  await install(`${url}/tree/main/skills/plan`, ['skills/plan/SKILL.md']);
  assert.deepEqual(
    (await service.updateGroup('owner/repo')).map((skill) => skill.name),
    ['plan'],
  );
  assert.deepEqual(
    (await readSkillSources(join(service.root, 'owner/repo')))[0].installation,
    {
      mode: 'package',
      path: 'skills/plan/SKILL.md',
      name: 'plan',
    },
  );
});

test('legacy source records infer a previously installed root package and persist that mode', async (t) => {
  const { service, install } = await fixture(t);
  await install();
  const group = join(service.root, 'owner/repo');
  await writeFile(
    join(group, SKILL_SOURCES_FILE),
    JSON.stringify({ version: 1, sources: [{ url, ref: null, scope: '' }] }),
  );
  assert.deepEqual(
    (await service.updateGroup('owner/repo')).map((skill) => skill.name),
    ['complete-package'],
  );
  assert.equal(
    (await readSkillSources(group))[0].installation?.mode,
    'package',
  );
  assert.equal(
    JSON.parse(await readFile(join(group, SKILL_SOURCES_FILE), 'utf8')).version,
    2,
  );
});

test('package copy failure restores resources and the previous installation record', async (t) => {
  const { service, install, files, failCopy } = await fixture(t);
  const [installed] = await install();
  const group = join(service.root, 'owner/repo');
  const metadata = await readFile(join(group, SKILL_SOURCES_FILE), 'utf8');
  files.set('scripts/shared.py', '# changed');
  failCopy();
  await assert.rejects(service.updateGroup('owner/repo'), /copy failure/);
  assert.equal(
    await readFile(
      join(service.root, installed.path, 'scripts/shared.py'),
      'utf8',
    ),
    '# shared script',
  );
  assert.equal(
    await readFile(join(group, SKILL_SOURCES_FILE), 'utf8'),
    metadata,
  );
  assert.deepEqual(await readdir(join(service.root, '..')), ['skills']);
});

test('legacy Python root directories keep their existing name during migration', async (t) => {
  const { service, install, files } = await fixture(t);
  await install();
  const group = join(service.root, 'owner/repo');
  await rename(join(group, 'complete-package'), join(group, 'repo'));
  await writeFile(
    join(group, SKILL_SOURCES_FILE),
    JSON.stringify({ version: 1, sources: [{ url, ref: null, scope: '' }] }),
  );
  files.delete('SKILL.md');
  await assert.rejects(service.updateGroup('owner/repo'), {
    code: 'SKILL_UPDATE_SOURCE_NOT_FOUND',
  });
  assert.equal((await service.list()).skills[0].name, 'repo');
  files.set('SKILL.md', manifest('complete-package'));
  assert.deepEqual(
    (await service.updateGroup('owner/repo')).map((skill) => skill.name),
    ['repo'],
  );
  assert.deepEqual((await readSkillSources(group))[0].installation, {
    mode: 'package',
    path: 'SKILL.md',
    name: 'repo',
  });
});

test('legacy collection selections remain a collection when the root package was never installed', async (t) => {
  const { service, install } = await fixture(t);
  await install(`${url}/tree/main/skills`, ['skills/plan/SKILL.md']);
  const group = join(service.root, 'owner/repo');
  await writeFile(
    join(group, SKILL_SOURCES_FILE),
    JSON.stringify({ version: 1, sources: [{ url, ref: null, scope: '' }] }),
  );
  assert.deepEqual(
    (await service.updateGroup('owner/repo')).map((skill) => skill.name).sort(),
    ['debug', 'plan'],
  );
  assert.deepEqual((await readSkillSources(group))[0].installation, {
    mode: 'collection',
  });
});
