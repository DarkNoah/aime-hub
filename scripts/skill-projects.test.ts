import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Auth } from '@aime/auth';
import { scanSkillsSchema } from '@aime/shared/skills';
import { createApp } from '../apps/server/src/app.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import {
  readSkillProject,
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
  const workspace = await mkdtemp(join(tmpdir(), 'skill-projects-'));
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
  assert.equal(scan.project?.destination, 'owner/repo/project');
  assert.equal(scan.project?.fileCount, f.files.size);
  assert.equal(scan.project?.skippedFiles, 1);
  assert.deepEqual(
    scan.skills.map((skill) => skill.path).sort(),
    [main, hidden, 'skills/other/SKILL.md'].sort(),
  );
  const installed = await f.service.install(scan.id, [main, hidden]);
  const group = join(f.service.root, 'owner/repo');
  assert.deepEqual((await readdir(group)).sort(), [
    SKILL_PROJECT_FILE,
    SKILL_SOURCES_FILE,
    'project',
  ]);
  for (const [path, content] of f.files)
    assert.equal(await readFile(join(group, 'project', path), 'utf8'), content);
  await assert.rejects(readFile(join(group, 'project/linked/SKILL.md')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readSkillProject(group), {
    version: 1,
    root: 'project',
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
    assert.equal(skill.projectRoot, 'owner/repo/project');
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
    await readFile(join(group, 'project/rea_toon/cli.py'), 'utf8'),
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
  assert.equal(scan.skills[0].destination, 'owner/repo/project');
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
  const project = join(f.service.root, 'owner/repo/project');
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
      join(f.service.root, 'owner/repo', SKILL_SOURCES_FILE),
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
  const project = join(f.service.root, 'owner/repo/project');
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
      await readFile(join(directory, 'project/rea_toon/cli.py'), 'utf8'),
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
  assert.equal(scan.project?.destination, '@local/whole-project/project');
  const [installed] = await personal.install(scan.id, [main]);
  assert.equal(installed.path, '@local/whole-project/project/skills/rea-toon');
  assert.equal(
    await readFile(
      join(personal.root, '@local/whole-project/project/pyproject.toml'),
      'utf8',
    ),
    f.files.get('pyproject.toml'),
  );
  assert.deepEqual(
    await readSkillSources(join(personal.root, '@local/whole-project')),
    [],
  );
  await assert.rejects(personal.updateGroup('@local/whole-project'), {
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
      (await readSkillProject(join(f.service.root, '@local', name)))?.entries,
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
  await writeFile(join(group, SKILL_PROJECT_FILE), '{broken');
  await assert.rejects(f.service.list(), { code: 'SKILL_PROJECT_INVALID' });
  await writeFile(join(group, SKILL_PROJECT_FILE), JSON.stringify(metadata));
  const entry = join(group, 'project', main);
  await rm(entry);
  await assert.rejects(readSkillProject(group), {
    code: 'SKILL_PROJECT_INVALID',
  });
  await writeFile(join(f.workspace, 'outside.md'), manifest('outside'));
  await symlink(join(f.workspace, 'outside.md'), entry);
  await assert.rejects(readSkillProject(group), {
    code: 'SKILL_PROJECT_INVALID',
  });
  await rm(join(group, 'project/skills/rea-toon'), { recursive: true });
  await symlink(f.workspace, join(group, 'project/skills/rea-toon'));
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
