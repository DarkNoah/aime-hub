import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Auth } from '@aime/auth';
import { scanSkillsSchema } from '@aime/shared/skills';
import { createApp } from '../apps/server/src/app.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import { migrateSkillLayouts } from '../apps/server/src/modules/skills/layout-migration.js';
import {
  readSkillProject,
  SKILL_META_DIRECTORY,
  SKILL_PROJECT_FILE,
  skillProjectSchema,
} from '../apps/server/src/modules/skills/project.js';
import {
  readSkillSources,
  SKILL_SOURCES_FILE,
} from '../apps/server/src/modules/skills/sources.js';
import {
  resolveRepositoryScope,
  type RepositorySnapshot,
} from '../apps/server/src/modules/skills/github.js';

const { zipSync } = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
)('fflate') as {
  zipSync(files: Record<string, Uint8Array>): Uint8Array;
};
const manifest = (name: string) =>
  `---\nname: ${name}\ndescription: Project fixture\n---\nUse project sibling resources.\n`;
const url = 'https://github.com/owner/repo';
const main = 'skills/rea-toon/SKILL.md';
const hidden = '.claude/skills/hidden/SKILL.md';

async function fixture(t: test.TestContext) {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), 'skill-projects-')),
  );
  const files = new Map([
    [main, manifest('rea-toon')],
    ['skills/rea-toon/references/setup.md', 'Install from project root.'],
    ['skills/other/SKILL.md', manifest('other')],
    [hidden, manifest('hidden')],
    ['pyproject.toml', '[project]\nname="rea-toon"'],
    ['rea_toon/cli.py', '# original application'],
    ['assets/图片.bin', '\u0000\u00ff'],
    ['.github/workflows/build.yml', 'name: build'],
    ['.skill-project.json', '{"untrusted":"upstream-file"}'],
    ['.skill-sources.json', '{"untrusted":"upstream-source"}'],
  ]);
  const requests: { ref?: string | null; scope?: string }[] = [];
  let failCopy = false;
  let skipped = false;
  let disposed = 0;
  const service = new SkillService(
    workspace,
    async (repository, _signal, original): Promise<RepositorySnapshot> => {
      requests.push({ ref: original?.ref, scope: original?.scope });
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
        files: [
          ...[...snapshot].map(([path, content]) => ({
            path,
            oid: path,
            size: Buffer.byteLength(content),
            mode: '100644',
          })),
          ...(skipped
            ? [
                {
                  path: 'linked/SKILL.md',
                  oid: 'link',
                  size: 10,
                  mode: '120000',
                },
              ]
            : []),
        ],
        read: async (file) => {
          if (failCopy && file.path.endsWith('.py'))
            throw new Error('copy failure');
          return Buffer.from(snapshot.get(file.path)!);
        },
        dispose: async () => {
          disposed++;
        },
      };
    },
  );
  t.after(async () => {
    await service.dispose();
    await rm(workspace, { recursive: true, force: true });
  });
  const install = async (paths = [main], source = url) => {
    const scan = await service.scan(source, undefined, 'project');
    return service.install(scan.id, paths);
  };
  return {
    workspace,
    service,
    files,
    requests,
    install,
    failCopy: () => {
      failCopy = true;
    },
    skipLink: () => {
      skipped = true;
    },
    disposed: () => disposed,
  };
}

async function legacyProject(
  f: Awaited<ReturnType<typeof fixture>>,
  group = 'owner/repo',
  withSource = true,
) {
  const directory = join(f.service.root, group);
  for (const [path, content] of f.files) {
    const output = join(directory, 'project', path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content);
  }
  const metadata = {
    version: 1,
    root: 'project',
    entries: [{ path: main, name: 'rea-toon' }],
  };
  await writeFile(
    join(directory, SKILL_PROJECT_FILE),
    JSON.stringify(metadata),
  );
  if (withSource)
    await writeFile(
      join(directory, SKILL_SOURCES_FILE),
      JSON.stringify({
        version: 2,
        sources: [
          {
            url,
            ref: 'main',
            scope: '',
            installation: { mode: 'project', entries: metadata.entries },
          },
        ],
      }),
    );
  return directory;
}

test('whole project import preserves all siblings, hidden files and original paths while enabling only selected entries', async (t) => {
  const f = await fixture(t);
  f.skipLink();
  const scan = await f.service.scan(
    `${url}/tree/main/skills/rea-toon`,
    undefined,
    'project',
  );
  assert.equal(scan.importMode, 'project');
  assert.equal(scan.scope, '');
  assert.equal(scan.ref, 'main');
  assert.equal(scan.project?.destination, 'owner/repo');
  assert.equal(scan.project?.fileCount, f.files.size);
  assert.equal(scan.project?.skippedFiles, 1);
  assert.deepEqual(
    scan.skills.map((skill) => skill.path).sort(),
    [main, hidden, 'skills/other/SKILL.md'].sort(),
  );
  const installed = await f.service.install(scan.id, [main, hidden]);
  const group = join(f.service.root, 'owner/repo');
  assert.ok((await readdir(group)).includes(SKILL_META_DIRECTORY));
  assert.deepEqual((await readdir(join(group, SKILL_META_DIRECTORY))).sort(), [
    SKILL_PROJECT_FILE,
    SKILL_SOURCES_FILE,
  ]);
  for (const [path, content] of f.files)
    assert.equal(await readFile(join(group, path), 'utf8'), content);
  await assert.rejects(readFile(join(group, 'linked/SKILL.md')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readSkillProject(group), {
    version: 2,
    root: '.',
    entries: [
      { path: main, name: 'rea-toon' },
      { path: hidden, name: 'hidden' },
    ],
  });
  const [source] = await readSkillSources(group);
  assert.equal(source.url, url);
  assert.equal(source.ref, 'main');
  assert.equal(source.scope, '');
  assert.deepEqual(source.installation, {
    mode: 'project',
    entries: [
      { path: main, name: 'rea-toon' },
      { path: hidden, name: 'hidden' },
    ],
  });
  assert.deepEqual((await f.service.list()).skills, installed);
  for (const skill of installed) {
    assert.equal(skill.group, 'owner/repo');
    assert.equal(skill.projectRoot, 'owner/repo');
    assert.equal(skill.sourceType, 'github');
    assert.equal((await f.service.read(skill.path)).skill.name, skill.name);
    assert.equal(
      await f.service.withFiles(skill.path, (root) =>
        readFile(join(root, 'SKILL.md'), 'utf8'),
      ),
      manifest(skill.name),
    );
    await assert.rejects(f.service.remove(skill.path), {
      code: 'SKILL_PROJECT_MANAGED',
    });
  }
  await assert.rejects(
    f.service.removeGroup('owner/repo', [installed[0].path]),
    { code: 'SKILL_GROUP_CHANGED' },
  );
  assert.equal(
    await readFile(join(group, 'rea_toon/cli.py'), 'utf8'),
    '# original application',
  );
  assert.deepEqual(
    await f.service.removeGroup(
      'owner/repo',
      installed.map((skill) => skill.path),
    ),
    installed.map((skill) => skill.path),
  );
  await assert.rejects(readdir(group), { code: 'ENOENT' });
});

test('root project packages keep nested manifests bundled and duplicate entry names stay stable', async (t) => {
  const f = await fixture(t);
  f.files.set('SKILL.md', manifest('root-project'));
  let scan = await f.service.scan(url, undefined, 'project');
  assert.deepEqual(
    scan.skills.map((skill) => skill.path),
    ['SKILL.md'],
  );
  assert.equal(scan.skills[0].destination, 'owner/repo');
  assert.equal(scan.skills[0].bundledSkills?.length, 3);
  await assert.rejects(f.service.install(scan.id, [main]), {
    code: 'SKILL_INVALID_SELECTION',
  });
  const [root] = await f.install(['SKILL.md']);
  assert.equal(root.name, 'root-project');
  assert.deepEqual((await f.service.list()).skills, [root]);
  await f.service.removeGroup('owner/repo', [root.path]);
  f.files.delete('SKILL.md');
  f.files.set('other/rea-toon/SKILL.md', manifest('same-name'));
  scan = await f.service.scan(url, undefined, 'project');
  const names = scan.skills
    .filter((skill) => skill.name.startsWith('rea-toon-'))
    .map((skill) => skill.name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => /^rea-toon-[a-f0-9]{8}$/.test(name)));
  const installed = await f.service.install(
    scan.id,
    scan.skills.map((skill) => skill.path),
  );
  assert.deepEqual(
    (await f.service.list()).skills.map((skill) => skill.name),
    installed.map((skill) => skill.name),
  );
});

test('project updates replace the complete tree and preserve the selected entries and names', async (t) => {
  const f = await fixture(t);
  const installed = await f.install([main, hidden], `${url}/blob/main/${main}`);
  f.files.set(main, manifest('upstream-renamed'));
  f.files.set('rea_toon/cli.py', '# updated application');
  f.files.set('new-feature/tool.py', '# new file');
  f.files.delete('assets/图片.bin');
  const updated = await f.service.updateGroup('owner/repo');
  assert.deepEqual(updated, installed);
  assert.deepEqual(f.requests.at(-1), { ref: 'main', scope: '' });
  const project = join(f.service.root, 'owner/repo');
  assert.equal(
    await readFile(join(project, 'rea_toon/cli.py'), 'utf8'),
    '# updated application',
  );
  assert.equal(
    await readFile(join(project, 'new-feature/tool.py'), 'utf8'),
    '# new file',
  );
  await assert.rejects(readFile(join(project, 'assets/图片.bin')), {
    code: 'ENOENT',
  });
  assert.equal((await f.service.list()).skills.length, 2);
  const metadata = JSON.parse(
    await readFile(
      join(
        f.service.root,
        'owner/repo',
        SKILL_META_DIRECTORY,
        SKILL_SOURCES_FILE,
      ),
      'utf8',
    ),
  );
  assert.equal(metadata.version, 2);
  assert.deepEqual(metadata.sources[0].installation.entries, [
    { path: main, name: 'rea-toon' },
    { path: hidden, name: 'hidden' },
  ]);
});

test('missing or invalid enabled entries and failed copy leave the previous project complete', async (t) => {
  const f = await fixture(t);
  const installed = await f.install();
  const project = join(f.service.root, 'owner/repo');
  f.files.delete(main);
  await assert.rejects(f.service.updateGroup('owner/repo'), {
    code: 'SKILL_UPDATE_SOURCE_NOT_FOUND',
  });
  f.files.set(main, 'invalid manifest');
  await assert.rejects(f.service.updateGroup('owner/repo'), {
    code: 'SKILL_UPDATE_EMPTY',
  });
  f.files.set(main, manifest('rea-toon'));
  // A newly added ancestor manifest makes a formerly independent entry unsafe to enable separately.
  f.files.set('SKILL.md', manifest('new-root'));
  await assert.rejects(f.service.updateGroup('owner/repo'), {
    code: 'SKILL_UPDATE_SOURCE_NOT_FOUND',
  });
  f.files.delete('SKILL.md');
  f.files.set('rea_toon/cli.py', '# changed but must not survive');
  f.failCopy();
  await assert.rejects(f.service.updateGroup('owner/repo'), /copy failure/);
  assert.deepEqual((await f.service.list()).skills, installed);
  assert.equal(
    await readFile(join(project, 'rea_toon/cli.py'), 'utf8'),
    '# original application',
  );
  assert.equal(
    await readFile(join(project, main), 'utf8'),
    manifest('rea-toon'),
  );
  assert.deepEqual(await readdir(join(f.service.root, 'owner')), ['repo']);
});

test('projects cannot mix with ordinary installs or existing groups, including empty groups', async (t) => {
  const f = await fixture(t);
  const oldScan = await f.service.scan(url);
  await f.install();
  await assert.rejects(
    f.service.install(oldScan.id, ['skills/other/SKILL.md']),
    { code: 'SKILL_CONFLICT' },
  );
  await assert.rejects(f.service.scan(url), { code: 'SKILL_CONFLICT' });
  const second = await f.service.scan(url, undefined, 'project');
  assert.ok(second.skills.every((skill) => skill.installed));
  await assert.rejects(f.service.install(second.id, [hidden]), {
    code: 'SKILL_CONFLICT',
  });
  const installed = (await f.service.list()).skills;
  await f.service.removeGroup(
    'owner/repo',
    installed.map((skill) => skill.path),
  );
  await mkdir(join(f.service.root, 'owner/repo'));
  await assert.rejects(f.install(), { code: 'SKILL_CONFLICT' });
  await rm(join(f.service.root, 'owner/repo'), { recursive: true });
  const ordinary = await f.service.scan(url);
  await f.service.install(ordinary.id, [main]);
  await assert.rejects(f.install(), { code: 'SKILL_CONFLICT' });
});

test('a failed initial update rename never removes the original project', async (t) => {
  const f = await fixture(t);
  const installed = await f.install();
  const directory = join(f.service.root, 'owner/repo');
  const rename = fs.rename;
  const mocked = t.mock.method(
    fs,
    'rename',
    async (...[from, to]: Parameters<typeof fs.rename>) => {
      if (from === directory) throw new Error('rename denied');
      return rename(from, to);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.service.updateGroup('owner/repo'), /rename denied/);
    assert.deepEqual((await f.service.list()).skills, installed);
    assert.equal(
      await readFile(join(directory, 'rea_toon/cli.py'), 'utf8'),
      '# original application',
    );
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an explicit update source resolves the new ref while preserving enabled entry names', async (t) => {
  const f = await fixture(t);
  const installed = await f.install([main], `${url}/tree/main/skills/rea-toon`);
  const commit = 'b'.repeat(40);
  assert.deepEqual(
    await f.service.updateGroup(
      'owner/repo',
      `${url}/tree/${commit}/skills/rea-toon`,
    ),
    installed,
  );
  const [source] = await readSkillSources(join(f.service.root, 'owner/repo'));
  assert.equal(source.url, url);
  assert.equal(source.ref, commit);
  assert.equal(source.scope, '');
  assert.deepEqual(source.installation, {
    mode: 'project',
    entries: [{ path: main, name: 'rea-toon' }],
  });
});

test('archives preserve the complete project without inventing GitHub update sources', async (t) => {
  const f = await fixture(t);
  const data = Buffer.from(
    zipSync(
      Object.fromEntries(
        [...f.files].map(([path, value]) => [
          `wrapper/${path}`,
          Buffer.from(value),
        ]),
      ),
    ),
  );
  const personal = f.service.forUser('alice');
  const scan = await personal.scanArchive(
    'Whole Project.SKILL',
    data,
    undefined,
    'project',
  );
  assert.equal(scan.sourceType, 'archive');
  assert.equal(scan.project?.destination, 'whole-project');
  const [installed] = await personal.install(scan.id, [main]);
  assert.equal(installed.path, 'whole-project/skills/rea-toon');
  assert.equal(installed.sourceType, 'archive');
  assert.equal(
    await readFile(join(personal.root, 'whole-project/pyproject.toml'), 'utf8'),
    f.files.get('pyproject.toml'),
  );
  assert.deepEqual(
    await readSkillSources(join(personal.root, 'whole-project')),
    [],
  );
  await assert.rejects(personal.updateGroup('whole-project'), {
    code: 'SKILL_SOURCE_UNKNOWN',
  });
  assert.deepEqual((await f.service.list()).skills, []);
  assert.deepEqual((await personal.list()).skills, [installed]);
});

test('project archives unwrap one packaging directory and retain actual project subdirectories', async (t) => {
  const f = await fixture(t);
  for (const [name, files, path, resources] of [
    [
      'root',
      {
        'repo-main/SKILL.md': manifest('root'),
        'repo-main/pyproject.toml': 'config',
        'repo-main/src/app.py': 'code',
      },
      'SKILL.md',
      ['pyproject.toml', 'src/app.py'],
    ],
    [
      'once',
      {
        'outer/inner/SKILL.md': manifest('once'),
        'outer/inner/src/app.py': 'code',
      },
      'inner/SKILL.md',
      ['inner/src/app.py'],
    ],
    [
      'unwrapped',
      { 'SKILL.md': manifest('unwrapped'), 'src/app.py': 'code' },
      'SKILL.md',
      ['src/app.py'],
    ],
    [
      'multiple',
      { 'first/SKILL.md': manifest('multiple'), 'second/src/app.py': 'code' },
      'first/SKILL.md',
      ['second/src/app.py'],
    ],
  ] as const) {
    const data = Buffer.from(
      zipSync(
        Object.fromEntries(
          Object.entries(files).map(([path, content]) => [
            path,
            Buffer.from(content!),
          ]),
        ),
      ),
    );
    const scan = await f.service.scanArchive(
      `${name}.zip`,
      data,
      undefined,
      'project',
    );
    assert.equal(scan.skills[0].path, path);
    const [installed] = await f.service.install(scan.id, [path]);
    const root = join(f.service.root, installed.projectRoot!);
    for (const resource of resources)
      assert.ok((await readFile(join(root, resource))).length);
    assert.deepEqual(
      (await readSkillProject(join(f.service.root, name)))?.entries,
      [{ path, name: installed.name }],
    );
  }
});

test('metadata fails closed on malformed entries, missing files and symlinks', async (t) => {
  const f = await fixture(t);
  await f.install();
  const group = join(f.service.root, 'owner/repo');
  const metadata = (await readSkillProject(group))!;
  assert.equal(
    skillProjectSchema.safeParse({
      ...metadata,
      entries: [{ path: '../SKILL.md', name: 'escape' }],
    }).success,
    false,
  );
  assert.equal(
    skillProjectSchema.safeParse({
      ...metadata,
      entries: [...metadata.entries, { path: 'SKILL.md', name: 'root' }],
    }).success,
    false,
  );
  assert.equal(
    skillProjectSchema.safeParse({
      ...metadata,
      entries: [...metadata.entries, metadata.entries[0]],
    }).success,
    false,
  );
  await writeFile(
    join(group, SKILL_META_DIRECTORY, SKILL_PROJECT_FILE),
    '{broken',
  );
  await assert.rejects(f.service.list(), { code: 'SKILL_PROJECT_INVALID' });
  await writeFile(
    join(group, SKILL_META_DIRECTORY, SKILL_PROJECT_FILE),
    JSON.stringify(metadata),
  );
  const entry = join(group, main);
  await rm(entry);
  await assert.rejects(readSkillProject(group), {
    code: 'SKILL_PROJECT_INVALID',
  });
  await writeFile(join(f.workspace, 'outside.md'), manifest('outside'));
  await symlink(join(f.workspace, 'outside.md'), entry);
  await assert.rejects(readSkillProject(group), {
    code: 'SKILL_PROJECT_INVALID',
  });
  await rm(join(group, 'skills/rea-toon'), { recursive: true });
  await symlink(f.workspace, join(group, 'skills/rea-toon'));
  await assert.rejects(readSkillProject(group), {
    code: 'SKILL_PROJECT_INVALID',
  });
});

test('group locks serialize installer mutations and release after failed imports', async (t) => {
  const f = await fixture(t);
  const scan = await f.service.scan(url, undefined, 'project');
  const owner = join(f.service.root, 'owner');
  const lock = join(owner, '.repo.skill-install.lock');
  await mkdir(lock, { recursive: true });
  await assert.rejects(f.service.install(scan.id, [main]), {
    code: 'SKILL_CONFLICT',
  });
  await rm(lock, { recursive: true });
  f.failCopy();
  await assert.rejects(f.service.install(scan.id, [main]), /copy failure/);
  assert.deepEqual(await readdir(owner), []);
  assert.equal(f.disposed(), 1);
});

test('ordinary archive containers and GitHub owners reject each other including cached scans', async (t) => {
  const f = await fixture(t);
  const data = Buffer.from(
    zipSync({ 'SKILL.md': Buffer.from(manifest('archive')) }),
  );
  const scans = await Promise.all([
    f.service.scan(url),
    f.service.scan(url, undefined, 'project'),
  ]);
  const archive = await f.service.scanArchive('owner.zip', data);
  await f.service.install(archive.id, ['SKILL.md']);
  for (const scan of scans)
    await assert.rejects(f.service.install(scan.id, [main]), {
      code: 'SKILL_CONFLICT',
    });
  for (const mode of ['skills', 'project'] as const)
    await assert.rejects(f.service.scan(url, undefined, mode), {
      code: 'SKILL_CONFLICT',
    });
  await f.service.removeGroup('owner', ['owner/archive']);
  const stale = await f.service.scanArchive('owner.zip', data);
  const github = await f.service.scan(url);
  await f.service.install(github.id, [main]);
  await assert.rejects(f.service.install(stale.id, ['SKILL.md']), {
    code: 'SKILL_CONFLICT',
  });
  assert.equal((await f.service.list()).skills[0]?.path, 'owner/repo/rea-toon');
});

test('legacy projects require migration before updates use the flattened project path', async (t) => {
  const f = await fixture(t);
  const directory = await legacyProject(f);
  assert.equal(await readSkillProject(directory), undefined);
  assert.equal(
    (await readSkillProject(directory, { legacy: true }))?.version,
    1,
  );
  const installed = (await f.service.list()).skills;
  assert.equal(installed[0].path, 'owner/repo/project/skills/rea-toon');
  assert.equal(installed[0].projectRoot, 'owner/repo/project');
  await assert.rejects(f.service.updateGroup('owner/repo'), {
    code: 'SKILL_CONFLICT',
  });
  await migrateSkillLayouts(f.workspace, async () => {});
  const migrated = (await f.service.list()).skills;
  assert.equal(migrated[0].path, 'owner/repo/skills/rea-toon');
  assert.equal(migrated[0].projectRoot, 'owner/repo');
  assert.equal((await readSkillProject(directory))?.version, 2);
  f.files.set('rea_toon/cli.py', '# new legacy application');
  assert.deepEqual(await f.service.updateGroup('owner/repo'), migrated);
  assert.equal(
    await readFile(join(directory, 'rea_toon/cli.py'), 'utf8'),
    '# new legacy application',
  );
  await assert.rejects(readdir(join(directory, 'project')), { code: 'ENOENT' });
  await f.service.removeGroup(
    'owner/repo',
    migrated.map((skill) => skill.path),
  );
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('migrated archive projects prevent duplicate imports under their canonical destination', async (t) => {
  const f = await fixture(t);
  const data = Buffer.from(
    zipSync(
      Object.fromEntries(
        [...f.files].map(([path, content]) => [path, Buffer.from(content)]),
      ),
    ),
  );
  const stale = await f.service.scanArchive(
    'archive.zip',
    data,
    undefined,
    'project',
  );
  await legacyProject(f, '@local/archive', false);
  await migrateSkillLayouts(f.workspace, async () => {});
  await assert.rejects(f.service.install(stale.id, [main]), {
    code: 'SKILL_CONFLICT',
  });
  const scan = await f.service.scanArchive(
    'archive.zip',
    data,
    undefined,
    'project',
  );
  assert.equal(scan.project?.destination, 'archive');
  assert.ok(scan.skills.every((skill) => skill.installed));
  await assert.rejects(f.service.install(scan.id, [main]), {
    code: 'SKILL_CONFLICT',
  });
  await assert.rejects(readdir(join(f.service.root, '@local')), {
    code: 'ENOENT',
  });
  const installed = (await f.service.list()).skills;
  assert.equal(installed[0].sourceType, 'archive');
  await f.service.removeGroup(
    'archive',
    installed.map((skill) => skill.path),
  );
  const next = await f.service.scanArchive(
    'archive.zip',
    data,
    undefined,
    'project',
  );
  assert.equal(next.project?.destination, 'archive');
  await f.service.install(next.id, [main]);
  assert.equal(
    (await f.service.list()).skills[0].path,
    'archive/skills/rea-toon',
  );
});

test('migrated archive projects retain wrapper resources at their installed locations', async (t) => {
  const f = await fixture(t);
  const mainPath = `repo-main/${main}`;
  const group = join(f.service.root, '@local/wrapped');
  await mkdir(dirname(join(group, 'project', mainPath)), { recursive: true });
  await writeFile(join(group, 'project', mainPath), manifest('rea-toon'));
  await writeFile(
    join(group, SKILL_PROJECT_FILE),
    JSON.stringify({
      version: 1,
      root: 'project',
      entries: [{ path: mainPath, name: 'rea-toon' }],
    }),
  );
  const data = Buffer.from(
    zipSync({
      [mainPath]: Buffer.from(manifest('rea-toon')),
      'repo-main/pyproject.toml': Buffer.from('config'),
    }),
  );
  await migrateSkillLayouts(f.workspace, async () => {});
  const installed = (await f.service.list()).skills;
  assert.equal(installed[0].path, 'wrapped/repo-main/skills/rea-toon');
  const scan = await f.service.scanArchive(
    'wrapped.zip',
    data,
    undefined,
    'project',
  );
  assert.equal(scan.skills[0].path, mainPath);
  assert.equal(scan.skills[0].destination, installed[0].path);
  assert.equal(scan.skills[0].installed, true);
  await assert.rejects(f.service.install(scan.id, [mainPath]), {
    code: 'SKILL_CONFLICT',
  });
});

test('single-directory projects cannot become GitHub owners, including stale scans and shared parent locks', async (t) => {
  const f = await fixture(t);
  const ordinary = await f.service.scan(url);
  const project = await f.service.scan(url, undefined, 'project');
  const data = Buffer.from(
    zipSync({
      'SKILL.md': Buffer.from(manifest('archive-owner')),
      'pyproject.toml': Buffer.from('shared'),
    }),
  );
  const scan = await f.service.scanArchive(
    'owner.zip',
    data,
    undefined,
    'project',
  );
  const installed = await f.service.install(scan.id, ['SKILL.md']);
  assert.equal(installed[0].path, 'owner');
  await assert.rejects(f.service.install(ordinary.id, [main]), {
    code: 'SKILL_CONFLICT',
  });
  await assert.rejects(f.service.install(project.id, [main]), {
    code: 'SKILL_CONFLICT',
  });
  await assert.rejects(f.service.scan(url), { code: 'SKILL_CONFLICT' });
  await assert.rejects(f.service.scan(url, undefined, 'project'), {
    code: 'SKILL_CONFLICT',
  });
  await assert.rejects(readdir(join(f.service.root, 'owner/repo')), {
    code: 'ENOENT',
  });
  assert.equal(
    await readFile(join(f.service.root, 'owner/pyproject.toml'), 'utf8'),
    'shared',
  );
  await f.service.removeGroup('owner', ['owner']);
  const retry = await f.service.scan(url);
  const parentLock = join(f.service.root, '.owner.skill-install.lock');
  await mkdir(parentLock);
  await assert.rejects(f.service.install(retry.id, [main]), {
    code: 'SKILL_CONFLICT',
  });
  await assert.rejects(readdir(join(f.service.root, 'owner')), {
    code: 'ENOENT',
  });
  await rm(parentLock, { recursive: true });
  await f.service.install(retry.id, [main]);
  const conflicting = await f.service.scanArchive(
    'owner.zip',
    data,
    undefined,
    'project',
  );
  await assert.rejects(f.service.install(conflicting.id, ['SKILL.md']), {
    code: 'SKILL_CONFLICT',
  });
  assert.equal((await f.service.list()).skills[0].path, 'owner/repo/rea-toon');
  assert.deepEqual(await readdir(f.service.root), ['owner']);
});

test('new projects reject reserved metadata source files, directories and case variants', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '.skill-meta',
    '.skill-meta/config.json',
    '.SKILL-META/private.json',
  ]) {
    f.files.set(path, 'upstream');
    await assert.rejects(f.service.scan(url, undefined, 'project'), {
      code: 'SKILL_CONFLICT',
    });
    f.files.delete(path);
  }
  for (const wrapper of ['.skill-meta', '.SKILL-META']) {
    const data = Buffer.from(
      zipSync({ [`${wrapper}/SKILL.md`]: Buffer.from(manifest('reserved')) }),
    );
    await assert.rejects(
      f.service.scanArchive('reserved.zip', data, undefined, 'project'),
      { code: 'SKILL_CONFLICT' },
    );
  }
  for (const wrapper of ['', 'repo-main/']) {
    for (const path of [
      '.skill-meta/',
      '.SKILL-META/',
      '.skill-meta',
      '.skill-meta/config.json',
    ]) {
      const data = Buffer.from(
        zipSync({
          [`${wrapper}SKILL.md`]: Buffer.from(manifest('reserved')),
          [`${wrapper}${path}`]: Buffer.from(
            path.endsWith('/') ? '' : 'reserved',
          ),
        }),
      );
      await assert.rejects(
        f.service.scanArchive('reserved.zip', data, undefined, 'project'),
        { code: 'SKILL_CONFLICT' },
      );
    }
  }
  const archive = Buffer.from(
    zipSync({ 'SKILL.md': Buffer.from(manifest('reserved')) }),
  );
  for (const name of ['plugins', 'builtin']) {
    await assert.rejects(
      f.service.scanArchive(`${name}.zip`, archive, undefined, 'project'),
      { code: 'SKILL_UNSAFE_PATH' },
    );
    await assert.rejects(readdir(join(f.service.root, name)), {
      code: 'ENOENT',
    });
  }
});

test('project root file APIs hide and protect managed metadata while preserving upstream dot files', async (t) => {
  const f = await fixture(t);
  f.files.set('SKILL.md', manifest('root'));
  const [global] = await f.install(['SKILL.md']);
  const personal = f.service.forUser('admin');
  const archive = Buffer.from(
    zipSync(
      Object.fromEntries(
        [...f.files].map(([path, content]) => [path, Buffer.from(content)]),
      ),
    ),
  );
  const scan = await personal.scanArchive(
    'root.zip',
    archive,
    undefined,
    'project',
  );
  const [local] = await personal.install(scan.id, ['SKILL.md']);
  const origin = 'http://localhost:5173';
  const auth = {
    api: { getSession: async () => ({ user: { id: 'admin', role: 'admin' } }) },
  } as unknown as Auth;
  const app = createApp(auth, undefined, undefined, {
    service: f.service,
    webOrigin: origin,
  });
  for (const [scope, installed] of [
    ['admin/skills', global],
    ['skills', local],
  ] as const) {
    const base = `/api/${scope}/files`;
    const route = (suffix: string, path = '') =>
      `${base}${suffix}?${new URLSearchParams({ skill: installed.path, path })}`;
    const request = (url: string, options: RequestInit = {}) =>
      app.request(url, {
        ...options,
        headers: { origin, 'content-type': 'application/json' },
      });
    const listing = await request(route(''));
    assert.equal(listing.status, 200);
    const entries = (await listing.json()).entries as { name: string }[];
    assert.ok(!entries.some((entry) => entry.name === SKILL_META_DIRECTORY));
    assert.ok(entries.some((entry) => entry.name === SKILL_PROJECT_FILE));
    assert.equal(
      (await request(route('/preview', SKILL_SOURCES_FILE))).status,
      200,
    );
    for (const path of [
      SKILL_META_DIRECTORY,
      `${SKILL_META_DIRECTORY}/${SKILL_PROJECT_FILE}`,
      `.SKILL-META/${SKILL_PROJECT_FILE}`,
    ]) {
      for (const suffix of ['', '/preview', '/raw'])
        assert.equal(
          (await request(route(suffix, path))).status,
          403,
          `${scope} ${suffix} ${path}`,
        );
      assert.equal(
        (
          await request(route('/content'), {
            method: 'PUT',
            body: JSON.stringify({ path, text: '{}', version: 'anything' }),
          })
        ).status,
        403,
      );
      const rpc = scope === 'skills' ? 'personalSkills' : 'skills';
      assert.equal(
        (
          await request(`/api/rpc/${rpc}/files/save`, {
            method: 'POST',
            body: JSON.stringify({
              json: {
                query: { skill: installed.path },
                body: { path, text: '{}', version: 'anything' },
              },
            }),
          })
        ).status,
        403,
      );
    }
  }
  assert.deepEqual((await f.service.list()).skills, [global]);
  assert.deepEqual((await personal.list()).skills, [local]);
});

test('scan schemas and both upload APIs accept project mode and reject invalid mode fields', async (t) => {
  const f = await fixture(t);
  assert.equal(scanSkillsSchema.parse({ url }).mode, 'skills');
  assert.equal(
    scanSkillsSchema.parse({ url, mode: 'project' }).mode,
    'project',
  );
  assert.equal(
    scanSkillsSchema.safeParse({ url, mode: 'unknown' }).success,
    false,
  );
  const webOrigin = 'http://localhost:5173';
  const auth = {
    api: { getSession: async () => ({ user: { id: 'admin', role: 'admin' } }) },
  } as unknown as Auth;
  const app = createApp(auth, undefined, undefined, {
    service: f.service,
    webOrigin,
  });
  const data = zipSync({
    [main]: Buffer.from(manifest('rea-toon')),
    'pyproject.toml': Buffer.from('shared'),
  });
  for (const scope of ['skills', 'admin/skills']) {
    const body = new FormData();
    body.set('file', new File([new Uint8Array(data)], 'project.zip'));
    body.set('mode', 'project');
    const response = await app.request(`/api/${scope}/archives`, {
      method: 'POST',
      body,
      headers: { origin: webOrigin },
    });
    assert.equal(response.status, 200);
    const scan = await response.json();
    assert.equal(scan.importMode, 'project');
    assert.equal(scan.project.fileCount, 2);
    await (scope === 'skills' ? f.service.forUser('admin') : f.service).install(
      scan.id,
      [main],
    );
    body.append('mode', 'project');
    assert.equal(
      (
        await app.request(`/api/${scope}/archives`, {
          method: 'POST',
          body,
          headers: { origin: webOrigin },
        })
      ).status,
      400,
    );
    body.set('mode', 'invalid');
    assert.equal(
      (
        await app.request(`/api/${scope}/archives`, {
          method: 'POST',
          body,
          headers: { origin: webOrigin },
        })
      ).status,
      400,
    );
  }
});
