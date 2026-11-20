import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import { readSkillProject } from '../apps/server/src/modules/skills/project.js';
import { readSkillSources } from '../apps/server/src/modules/skills/sources.js';
import { readGitSnapshot } from '../apps/server/src/modules/skills/github.js';
import { readSkillArchive } from '../apps/server/src/modules/skills/archive.js';

const exec = promisify(execFile);
const scripts = resolve(
  'apps/server/src/mastra/skills/skill-installer/scripts',
);
const manifest = (name: string) =>
  `---\nname: ${name}\ndescription: Project fixture\n---\n# Use ${name}\n`;
type Entry = { path: string; content: string; mode?: number };
const zipWriter = `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as package:
    for entry in json.loads(sys.argv[2]):
        info = zipfile.ZipInfo(entry["path"])
        info.create_system = 3
        info.external_attr = entry.get("mode", 0o100644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        package.writestr(info, entry["content"])
`;
type Row = {
  name: string;
  path: string;
  manifest: string;
  destination: string;
  installed: boolean;
  projectRoot?: string;
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'skill-installer-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(workspace, 'users/alice/.agents/skills');
  const temporary = join(root, 'temporary');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(temporary), mkdir(bin)]);
  const executable = (
    await exec('python3', ['-c', 'import sys; print(sys.executable)'])
  ).stdout.trim();
  const env = {
    ...process.env,
    SKILL_HOME: home,
    TMPDIR: temporary,
    PATH: bin,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const python = (args: string[], scope = home) =>
    exec(executable, args, {
      cwd: root,
      env: { ...env, SKILL_HOME: scope },
    });
  const run = (script: string, args: string[], scope = home) =>
    python([join(scripts, script), ...args], scope);
  return {
    root,
    home,
    workspace,
    temporary,
    bin,
    run,
    python,
    rows: async (args: string[] = [], scope = home): Promise<Row[]> =>
      JSON.parse(
        (await run('list-skills.py', [...args, '--format', 'json'], scope))
          .stdout,
      ),
    archive: async (name: string, entries: Entry[]) => {
      const path = join(root, name);
      await python(['-c', zipWriter, path, JSON.stringify(entries)]);
      return path;
    },
    clean: async (owner = '@local') => {
      assert.deepEqual(await readdir(temporary), []);
      for (const path of [home, join(home, owner)]) {
        const contents = await readdir(path).catch(() => []);
        assert.ok(
          contents.every(
            (name) =>
              !name.endsWith('.skill-install.lock') &&
              !name.startsWith('.skill-project-'),
          ),
        );
      }
    },
  };
}

const projectFiles: Entry[] = [
  { path: 'skills/rea-toon/SKILL.md', content: manifest('rea-toon') },
  {
    path: 'skills/rea-toon/examples/run.py',
    content: '# example\n',
    mode: 0o100755,
  },
  { path: 'skills/other/SKILL.md', content: manifest('other') },
  { path: 'rea_toon/__init__.py', content: '# sibling implementation\n' },
  { path: 'pyproject.toml', content: '[project]\nname = "fixture"\n' },
  { path: '.env.example', content: 'KEY=\n' },
];

test('whole-project archive imports unwrap one project root and keep siblings and unselected files in each scope', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('rea-toon.zip', [
    ...projectFiles.map((file) => ({
      ...file,
      path: `rea-toon-main/${file.path}`,
    })),
    { path: '.DS_Store', content: 'ignored archive metadata' },
  ]);
  const args = ['--archive', archive, '--whole-project'];
  assert.ok(
    (await f.rows(['--archive', archive])).every((row) =>
      row.manifest.startsWith('rea-toon-main/'),
    ),
  );
  const available = await f.rows(args);
  assert.deepEqual(available.map((row) => row.name).sort(), [
    'other',
    'rea-toon',
  ]);
  assert.equal(
    available.find((row) => row.name === 'rea-toon')?.destination,
    join(f.home, 'rea-toon/skills/rea-toon'),
  );
  assert.equal(
    (
      await f.run('list-skills.py', [
        ...args,
        '--path',
        'skills/rea-toon',
        '--preview',
      ])
    ).stdout.trim(),
    manifest('rea-toon').trim(),
  );
  await f.run('install-skill.py', [...args, '--path', 'skills/rea-toon']);
  const group = join(f.home, 'rea-toon');
  assert.deepEqual(await readSkillProject(group), {
    version: 2,
    root: '.',
    entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
  });
  assert.deepEqual((await readdir(group)).sort(), [
    '.env.example',
    '.skill-meta',
    'pyproject.toml',
    'rea_toon',
    'skills',
  ]);
  await assert.rejects(stat(join(f.home, '@local')), { code: 'ENOENT' });
  for (const file of projectFiles)
    assert.equal(await readFile(join(group, file.path), 'utf8'), file.content);
  await assert.rejects(stat(join(group, 'rea-toon-main')), {
    code: 'ENOENT',
  });
  assert.equal(
    (await stat(join(group, 'skills/rea-toon/examples/run.py'))).mode & 0o777,
    0o755,
  );
  const listing = await f.rows();
  assert.deepEqual(
    listing.map((row) => row.path),
    ['rea-toon/skills/rea-toon'],
  );
  assert.equal(listing[0].projectRoot, 'rea-toon');
  const rescanned = await f.rows(args);
  assert.equal(
    rescanned.find((row) => row.name === 'rea-toon')?.installed,
    true,
  );
  assert.equal(rescanned.find((row) => row.name === 'other')?.installed, false);
  const scope = join(f.workspace, 'projects/project/.agents/skills');
  await f.run('install-skill.py', args, scope);
  assert.equal((await f.rows([], scope)).length, 2);
  assert.equal((await f.rows()).length, 1);
  const nested = await f.archive(
    'nested.zip',
    projectFiles.map((file) => ({
      ...file,
      path: `release/inner/${file.path}`,
    })),
  );
  const nestedArgs = ['--archive', nested, '--whole-project'];
  assert.ok(
    (await f.rows(nestedArgs)).every((row) =>
      row.manifest.startsWith('inner/'),
    ),
  );
  await f.run('install-skill.py', nestedArgs);
  assert.equal(
    await readFile(join(f.home, 'nested/inner/pyproject.toml'), 'utf8'),
    projectFiles.find((file) => file.path === 'pyproject.toml')!.content,
  );
  await assert.rejects(stat(join(f.home, 'nested/pyproject.toml')), {
    code: 'ENOENT',
  });
  await f.clean();
});

test('whole-project roots suppress bundled entries and hidden or duplicate paths keep stable names', async (t) => {
  const f = await fixture(t);
  const rootArchive = await f.archive(
    'Root.skill',
    [
      { path: 'SKILL.md', content: manifest('root-name') },
      ...projectFiles,
      { path: 'hidden/.skill-project.json', content: '{"untrusted":true}' },
    ].map((file) => ({ ...file, path: `root-main/${file.path}` })),
  );
  const rootArgs = ['--archive', rootArchive, '--whole-project'];
  const roots = await f.rows(rootArgs);
  assert.deepEqual(
    roots.map((row) => row.name),
    ['root-name'],
  );
  assert.equal(roots[0].destination, join(f.home, 'root'));
  await assert.rejects(
    f.run('install-skill.py', [...rootArgs, '--path', 'skills/rea-toon']),
    /independent skill entry/,
  );
  await f.run('install-skill.py', rootArgs);
  assert.equal((await f.rows()).length, 1);
  assert.equal(
    await readFile(join(f.home, 'root/rea_toon/__init__.py'), 'utf8'),
    '# sibling implementation\n',
  );
  const paths = [
    '.agents/skills/same/SKILL.md',
    'wrapper/skills/same/SKILL.md',
  ];
  const hidden = await f.archive(
    'hidden.zip',
    paths.map((path) => ({ path, content: manifest('same') })),
  );
  const hiddenArgs = ['--archive', hidden, '--whole-project'];
  const expectedNames = paths.map(
    (path) =>
      `same-${createHash('sha256').update(path).digest('hex').slice(0, 8)}`,
  );
  assert.deepEqual(
    (await f.rows(hiddenArgs)).map((row) => row.name).sort(),
    expectedNames.sort(),
  );
  await f.run('install-skill.py', hiddenArgs);
  assert.deepEqual(
    (await f.rows())
      .filter((row) => row.path.startsWith('hidden/'))
      .map((row) => row.path)
      .sort(),
    paths.map((path) => `hidden/${dirname(path)}`).sort(),
  );
  await f.clean();
});

test('ordinary and whole-project archives share the same flat group and cannot mix', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('conflict.zip', projectFiles);
  const args = ['--archive', archive];
  await f.run('install-skill.py', [...args, '--path', 'skills/rea-toon']);
  const group = join(f.home, 'conflict');
  assert.deepEqual((await readdir(group)).sort(), ['.skill-meta', 'rea-toon']);
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /group already exists/,
  );
  await rm(group, { recursive: true });
  await mkdir(group);
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /group already exists/,
  );
  assert.deepEqual(await readdir(group), []);
  await rm(group, { recursive: true });
  const lock = join(f.home, '.conflict.skill-install.lock');
  await mkdir(lock);
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /Another install is active/,
  );
  const service = new SkillService(f.workspace);
  t.after(() => service.dispose());
  const personal = service.forUser('alice');
  const scan = await personal.scanArchive(
    'conflict.zip',
    await readFile(archive),
    undefined,
    'project',
  );
  await assert.rejects(
    personal.install(
      scan.id,
      scan.skills.map((skill) => skill.path),
    ),
    /SKILL_CONFLICT/,
  );
  await rm(lock, { recursive: true });
  await f.run('install-skill.py', [...args, '--whole-project']);
  const saved = await readFile(
    join(group, '.skill-meta/.skill-project.json'),
    'utf8',
  );
  await assert.rejects(
    f.run('install-skill.py', [...args, '--path', 'skills/other']),
    /whole project/,
  );
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /group already exists/,
  );
  assert.equal(
    await readFile(join(group, '.skill-meta/.skill-project.json'), 'utf8'),
    saved,
  );
  await f.clean();
});

test('whole-project publication and copy failures leave no destination, partial metadata, staging, or stale lock', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive(
    'rollback.zip',
    projectFiles.map((file) => ({
      ...file,
      path: `rollback-main/${file.path}`,
    })),
  );
  const script = `import importlib.util, pathlib, sys
sys.path.insert(0, sys.argv[1])
from archive import archive
from repository import skill_home
spec = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]) / "install-skill.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
original_rename = pathlib.Path.rename
def broken_rename(self, target):
    if self.name == "next": raise OSError("publish failed")
    return original_rename(self, target)
with archive(sys.argv[2]) as snapshot:
    if sys.argv[3] == "rename": pathlib.Path.rename = broken_rename
    else:
        original_copy = snapshot.copy_file
        def broken_copy(file, output):
            original_copy(file, output)
            raise OSError("copy failed")
        snapshot.copy_file = broken_copy
    try: installer.install(skill_home(), snapshot, None, True)
    except OSError: pass
    else: raise AssertionError("Expected installation failure")
`;
  for (const failure of ['copy', 'rename']) {
    await f.python(['-c', script, scripts, archive, failure]);
    await assert.rejects(stat(join(f.home, 'rollback')), {
      code: 'ENOENT',
    });
    assert.deepEqual(await readdir(f.home), []);
    await f.clean();
  }
  await f.run('install-skill.py', ['--archive', archive, '--whole-project']);
  assert.equal((await f.rows()).length, 2);
  await f.clean();
});

test('management and chat whole-project imports share metadata, hidden entry loading and actual installation destinations', async (t) => {
  const f = await fixture(t);
  const files = [
    ...projectFiles,
    { path: '.agents/skills/hidden/SKILL.md', content: manifest('hidden') },
  ];
  const wrapped = files.map((file) => ({
    ...file,
    path: `shared-main/${file.path}`,
  }));
  const archive = await f.archive('shared.skill', wrapped);
  const args = ['--archive', archive, '--whole-project'];
  await f.run('install-skill.py', [...args, '--path', '.agents/skills/hidden']);
  const service = new SkillService(f.workspace);
  t.after(() => service.dispose());
  const personal = service.forUser('alice');
  assert.deepEqual(
    (await personal.list()).skills.map((skill) => [
      skill.path,
      skill.projectRoot,
    ]),
    [['shared/.agents/skills/hidden', 'shared']],
  );
  const scan = await personal.scanArchive(
    'managed.skill',
    await readFile(archive),
    undefined,
    'project',
  );
  const selected = scan.skills.find(
    (skill) => skill.path === 'skills/rea-toon/SKILL.md',
  )!;
  assert.equal(selected.destination, 'managed/skills/rea-toon');
  await personal.install(scan.id, [selected.path]);
  assert.deepEqual(
    (await f.rows()).map((row) => [row.path, row.projectRoot]).sort(),
    [
      ['managed/skills/rea-toon', 'managed'],
      ['shared/.agents/skills/hidden', 'shared'],
    ],
  );
  assert.equal(
    await readFile(join(f.home, 'managed/rea_toon/__init__.py'), 'utf8'),
    '# sibling implementation\n',
  );
  const managedArchive = await f.archive('managed.skill', wrapped);
  assert.deepEqual(
    (await f.rows(['--archive', managedArchive, '--whole-project']))
      .filter((row) => row.installed)
      .map((row) => row.name),
    ['rea-toon'],
  );
  await f.clean();
});

test('scoped GitHub whole-project imports retain the complete requested branch and interoperable update source', async (t) => {
  const f = await fixture(t);
  const repo = join(f.root, 'source');
  await mkdir(repo);
  for (const file of projectFiles) {
    await mkdir(dirname(join(repo, file.path)), { recursive: true });
    await writeFile(join(repo, file.path), file.content);
  }
  await writeFile(
    join(repo, '.skill-project.json'),
    '{"source":"project-marker"}',
  );
  await writeFile(
    join(repo, '.skill-sources.json'),
    '{"source":"source-marker"}',
  );
  await symlink('/etc/passwd', join(repo, 'unsafe-link'));
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
    'main',
  );
  await git('switch', '-c', 'feature/skills');
  await writeFile(join(repo, 'branch-only.txt'), 'requested branch');
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
    'branch',
  );
  await git('switch', 'main');
  await writeFile(
    join(f.bin, 'git'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2).map(arg => arg.startsWith('https://') ? ${JSON.stringify(repo)} : arg);
const result = spawnSync('git', ['-c', 'protocol.file.allow=always', ...args], { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} }, stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  const args = [
    '--url',
    'https://github.com/Owner/Repo/tree/feature/skills/skills/rea-toon',
    '--whole-project',
  ];
  assert.equal((await f.rows(args)).length, 2);
  await f.run('install-skill.py', [...args, '--path', 'skills/rea-toon']);
  const group = join(f.home, 'owner/repo');
  await assert.rejects(
    f.run(
      'install-skill.py',
      args.filter((arg) => arg !== '--whole-project'),
    ),
    /whole project/,
  );
  assert.equal(
    await readFile(join(group, 'branch-only.txt'), 'utf8'),
    'requested branch',
  );
  assert.equal(
    await readFile(join(group, 'rea_toon/__init__.py'), 'utf8'),
    '# sibling implementation\n',
  );
  assert.deepEqual(await readSkillSources(group), [
    {
      url: 'https://github.com/owner/repo',
      ref: 'feature/skills',
      scope: '',
      installation: {
        mode: 'project',
        entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
      },
    },
  ]);
  for (const path of ['.git', 'unsafe-link'])
    await assert.rejects(stat(join(group, path)), {
      code: 'ENOENT',
    });
  await git('switch', 'feature/skills');
  await writeFile(join(repo, 'rea_toon/__init__.py'), '# updated sibling\n');
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
    'update sibling',
  );
  await git('switch', 'main');
  const service = new SkillService(
    f.workspace,
    async (_repository, _signal, original) => {
      assert.ok(original);
      assert.equal(original.ref, 'feature/skills');
      assert.equal(original.scope, '');
      return {
        ...(await readGitSnapshot(repo, original.ref!)),
        ref: original.ref!,
      };
    },
  );
  t.after(() => service.dispose());
  const updated = await service.forUser('alice').updateGroup('owner/repo');
  assert.deepEqual(
    updated.map((skill) => skill.path),
    ['owner/repo/skills/rea-toon'],
  );
  assert.equal(
    await readFile(join(group, 'rea_toon/__init__.py'), 'utf8'),
    '# updated sibling\n',
  );
  assert.deepEqual(
    (await f.rows()).map((row) => row.path),
    ['owner/repo/skills/rea-toon'],
  );
  assert.equal((await readSkillSources(group))[0].ref, 'feature/skills');
  assert.equal(
    await readFile(join(group, '.skill-project.json'), 'utf8'),
    '{"source":"project-marker"}',
  );
  assert.equal(
    await readFile(join(group, '.skill-sources.json'), 'utf8'),
    '{"source":"source-marker"}',
  );
  await f.clean('owner');
});

test('installed project metadata rejects malformed or escaping entries without following symlinks', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('invalid.zip', projectFiles);
  await f.run('install-skill.py', ['--archive', archive, '--whole-project']);
  const group = join(f.home, 'invalid');
  const marker = join(group, '.skill-meta/.skill-project.json');
  for (const record of [
    {
      version: true,
      root: '.',
      entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
    },
    {
      version: 2,
      root: '..',
      entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
    },
    {
      version: 2,
      root: '.',
      entries: [{ path: '../SKILL.md', name: 'escape' }],
    },
  ]) {
    await writeFile(marker, JSON.stringify(record));
    await assert.rejects(
      f.rows(),
      /Invalid project installation record|safe repository-relative path/,
    );
  }
  await writeFile(
    marker,
    JSON.stringify({
      version: 2,
      root: '.',
      entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
    }),
  );
  const target = join(group, 'skills/rea-toon');
  await rm(target, { recursive: true });
  await symlink(join(group, 'skills/other'), target);
  await assert.rejects(f.rows(), /symbolic link/);
  await f.clean();
});

test('flat project metadata preserves source root markers and rejects reserved source metadata without publication', async (t) => {
  const f = await fixture(t);
  const sourceMarkers = [
    {
      path: '.skill-project.json',
      content: '{"source":"keep-project-marker"}',
    },
    { path: '.skill-sources.json', content: '{"source":"keep-source-marker"}' },
  ];
  const archive = await f.archive('source-markers.skill', [
    ...projectFiles,
    ...sourceMarkers,
  ]);
  await f.run('install-skill.py', [
    '--archive',
    archive,
    '--whole-project',
    '--path',
    'skills/rea-toon',
  ]);
  const group = join(f.home, 'source-markers');
  for (const file of sourceMarkers)
    assert.equal(await readFile(join(group, file.path), 'utf8'), file.content);
  assert.deepEqual(await readSkillSources(group), []);
  const readSources = `import importlib.util, pathlib, json, sys
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]) / "install-skill.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
print(json.dumps(installer.read_sources(pathlib.Path(sys.argv[2]))))
`;
  assert.equal(
    (await f.python(['-c', readSources, scripts, group])).stdout.trim(),
    '[]',
  );
  const service = new SkillService(f.workspace);
  t.after(() => service.dispose());
  const personal = service.forUser('alice');
  assert.deepEqual(
    (await personal.list()).skills.map((skill) => skill.path),
    ['source-markers/skills/rea-toon'],
  );
  assert.equal(
    (await personal.read('source-markers/skills/rea-toon')).skill.projectRoot,
    'source-markers',
  );
  for (const reserved of ['.skill-meta', '.SKILL-META']) {
    const blocked = await f.archive('blocked.zip', [
      ...projectFiles,
      { path: `${reserved}/info.json`, content: 'source metadata' },
    ]);
    await assert.rejects(
      f.run('install-skill.py', ['--archive', blocked, '--whole-project']),
      /reserved .skill-meta/,
    );
    await assert.rejects(stat(join(f.home, 'blocked')), { code: 'ENOENT' });
    const empty = await f.archive('blocked-empty.zip', [
      ...projectFiles,
      {
        path: `${reserved}/`,
        content: '',
        mode: 0o40755,
      },
    ]);
    await assert.rejects(
      f.run('install-skill.py', ['--archive', empty, '--whole-project']),
      /reserved .skill-meta/,
    );
    await assert.rejects(stat(join(f.home, 'blocked-empty')), {
      code: 'ENOENT',
    });
    const disguised = await f.archive('blocked-wrapper.zip', [
      { path: `${reserved}/SKILL.md`, content: manifest('disguised') },
    ]);
    await assert.rejects(
      f.run('install-skill.py', ['--archive', disguised, '--whole-project']),
      /reserved .skill-meta/,
    );
    await assert.rejects(stat(join(f.home, 'blocked-wrapper')), {
      code: 'ENOENT',
    });
  }
  const marker = join(group, '.skill-meta/.skill-project.json');
  const saved = await readFile(marker, 'utf8');
  await rm(marker);
  await assert.rejects(f.rows(), /Invalid project installation record/);
  await writeFile(marker, saved);
  await f.clean();
});

test('legacy archive project groups remain read-only until service startup migrates their disk and application references', async (t) => {
  const f = await fixture(t);
  const legacyFiles = projectFiles.map((file) => ({
    ...file,
    path: `legacy-main/${file.path}`,
  }));
  const archive = await f.archive('legacy.zip', legacyFiles);
  const group = join(f.home, '@local/legacy');
  for (const file of legacyFiles) {
    const target = join(group, 'project', file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  await writeFile(
    join(group, '.skill-project.json'),
    JSON.stringify({
      version: 1,
      root: 'project',
      entries: [
        { path: 'legacy-main/skills/rea-toon/SKILL.md', name: 'rea-toon' },
      ],
    }),
  );
  const args = ['--archive', archive, '--whole-project'];
  await assert.rejects(f.rows(args), /Restart the application service/);
  assert.deepEqual(
    (await f.rows()).map((row) => [row.path, row.projectRoot]),
    [
      [
        '@local/legacy/project/legacy-main/skills/rea-toon',
        '@local/legacy/project',
      ],
    ],
  );
  await assert.rejects(
    f.run('install-skill.py', args),
    /Restart the application service/,
  );
  await assert.rejects(
    f.run('install-skill.py', ['--archive', archive]),
    /Restart the application service/,
  );
  await assert.rejects(stat(join(f.home, 'legacy')), { code: 'ENOENT' });
  const lock = join(f.home, '.@local.skill-install.lock');
  await mkdir(lock);
  const saved = join(f.root, 'legacy-update-backup');
  await rename(group, saved);
  await assert.rejects(
    f.run('install-skill.py', args),
    /legacy archive migration is active/,
  );
  await assert.rejects(stat(join(f.home, 'legacy')), { code: 'ENOENT' });
  await rename(saved, group);
  await rm(lock, { recursive: true });
  await f.clean();
});

test('single-directory archive projects cannot become GitHub owner containers in either import mode', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('owner.zip', projectFiles);
  await f.run('install-skill.py', ['--archive', archive, '--whole-project']);
  const original = await readFile(
    join(f.home, 'owner/.skill-meta/.skill-project.json'),
    'utf8',
  );
  const script = `import importlib.util, pathlib, sys
sys.path.insert(0, sys.argv[1])
from archive import archive
from repository import Source, skill_home, SkillError
spec = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]) / "install-skill.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
with archive(sys.argv[2]) as snapshot:
    snapshot.source = Source("owner", "repo", "https://github.com/owner/repo")
    for whole in [False, True]:
        try: installer.install(skill_home(), snapshot, None, whole)
        except SkillError as error:
            assert "parent directory contains a whole project" in str(error)
        else: raise AssertionError("Nested project installation must fail")
`;
  await f.python(['-c', script, scripts, archive]);
  const service = new SkillService(f.workspace, async () =>
    readSkillArchive('source.zip', await readFile(archive)),
  );
  t.after(() => service.dispose());
  for (const mode of ['skills', 'project'] as const)
    await assert.rejects(
      service.forUser('alice').scan('owner/repo', undefined, mode),
      /SKILL_CONFLICT/,
    );
  await assert.rejects(stat(join(f.home, 'owner/repo')), { code: 'ENOENT' });
  assert.equal(
    await readFile(
      join(f.home, 'owner/.skill-meta/.skill-project.json'),
      'utf8',
    ),
    original,
  );
  await f.clean('owner');
});
