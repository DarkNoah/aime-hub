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
      const contents = await readdir(join(home, owner)).catch(() => []);
      assert.ok(contents.every((path) => !path.startsWith('.')));
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
    join(f.home, '@local/rea-toon/project/skills/rea-toon'),
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
  const group = join(f.home, '@local/rea-toon');
  assert.deepEqual(await readSkillProject(group), {
    version: 1,
    root: 'project',
    entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
  });
  assert.deepEqual((await readdir(group)).sort(), [
    '.skill-project.json',
    'project',
  ]);
  for (const file of projectFiles)
    assert.equal(
      await readFile(join(group, 'project', file.path), 'utf8'),
      file.content,
    );
  await assert.rejects(stat(join(group, 'project/rea-toon-main')), {
    code: 'ENOENT',
  });
  assert.equal(
    (await stat(join(group, 'project/skills/rea-toon/examples/run.py'))).mode &
      0o777,
    0o755,
  );
  const listing = await f.rows();
  assert.deepEqual(
    listing.map((row) => row.path),
    ['@local/rea-toon/project/skills/rea-toon'],
  );
  assert.equal(listing[0].projectRoot, '@local/rea-toon/project');
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
    await readFile(
      join(f.home, '@local/nested/project/inner/pyproject.toml'),
      'utf8',
    ),
    projectFiles.find((file) => file.path === 'pyproject.toml')!.content,
  );
  await assert.rejects(
    stat(join(f.home, '@local/nested/project/pyproject.toml')),
    { code: 'ENOENT' },
  );
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
  assert.equal(roots[0].destination, join(f.home, '@local/root/project'));
  await assert.rejects(
    f.run('install-skill.py', [...rootArgs, '--path', 'skills/rea-toon']),
    /independent skill entry/,
  );
  await f.run('install-skill.py', rootArgs);
  assert.equal((await f.rows()).length, 1);
  assert.equal(
    await readFile(
      join(f.home, '@local/root/project/rea_toon/__init__.py'),
      'utf8',
    ),
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
      .filter((row) => row.path.startsWith('@local/hidden/'))
      .map((row) => row.path)
      .sort(),
    paths.map((path) => `@local/hidden/project/${dirname(path)}`).sort(),
  );
  await f.clean();
});

test('whole projects and ordinary packages cannot mix and empty destinations or shared locks are conflicts', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('conflict.zip', projectFiles);
  const args = ['--archive', archive];
  await f.run('install-skill.py', [...args, '--path', 'skills/rea-toon']);
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /group already exists/,
  );
  const group = join(f.home, '@local/conflict');
  assert.deepEqual(await readdir(group), ['rea-toon']);
  await rm(group, { recursive: true });
  await mkdir(group);
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /group already exists/,
  );
  assert.deepEqual(await readdir(group), []);
  await rm(group, { recursive: true });
  const lock = join(f.home, '@local/.conflict.skill-install.lock');
  await mkdir(lock);
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /Another install is active/,
  );
  await assert.rejects(
    f.run('install-skill.py', args),
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
  const saved = await readFile(join(group, '.skill-project.json'), 'utf8');
  await assert.rejects(f.run('install-skill.py', args), /whole project/);
  await assert.rejects(
    f.run('install-skill.py', [...args, '--whole-project']),
    /group already exists/,
  );
  assert.equal(
    await readFile(join(group, '.skill-project.json'), 'utf8'),
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
    await assert.rejects(stat(join(f.home, '@local/rollback')), {
      code: 'ENOENT',
    });
    assert.deepEqual(await readdir(join(f.home, '@local')), []);
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
    [['@local/shared/project/.agents/skills/hidden', '@local/shared/project']],
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
  assert.equal(selected.destination, '@local/managed/project/skills/rea-toon');
  await personal.install(scan.id, [selected.path]);
  assert.deepEqual(
    (await f.rows()).map((row) => [row.path, row.projectRoot]).sort(),
    [
      ['@local/managed/project/skills/rea-toon', '@local/managed/project'],
      ['@local/shared/project/.agents/skills/hidden', '@local/shared/project'],
    ],
  );
  assert.equal(
    await readFile(
      join(f.home, '@local/managed/project/rea_toon/__init__.py'),
      'utf8',
    ),
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
  assert.equal(
    await readFile(join(group, 'project/branch-only.txt'), 'utf8'),
    'requested branch',
  );
  assert.equal(
    await readFile(join(group, 'project/rea_toon/__init__.py'), 'utf8'),
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
    await assert.rejects(stat(join(group, 'project', path)), {
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
    ['owner/repo/project/skills/rea-toon'],
  );
  assert.equal(
    await readFile(join(group, 'project/rea_toon/__init__.py'), 'utf8'),
    '# updated sibling\n',
  );
  assert.deepEqual(
    (await f.rows()).map((row) => row.path),
    ['owner/repo/project/skills/rea-toon'],
  );
  assert.equal((await readSkillSources(group))[0].ref, 'feature/skills');
  await f.clean('owner');
});

test('installed project metadata rejects malformed or escaping entries without following symlinks', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('invalid.zip', projectFiles);
  await f.run('install-skill.py', ['--archive', archive, '--whole-project']);
  const group = join(f.home, '@local/invalid');
  const marker = join(group, '.skill-project.json');
  for (const record of [
    {
      version: true,
      root: 'project',
      entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
    },
    {
      version: 1,
      root: '..',
      entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
    },
    {
      version: 1,
      root: 'project',
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
      version: 1,
      root: 'project',
      entries: [{ path: 'skills/rea-toon/SKILL.md', name: 'rea-toon' }],
    }),
  );
  const target = join(group, 'project/skills/rea-toon');
  await rm(target, { recursive: true });
  await symlink(join(group, 'project/skills/other'), target);
  await assert.rejects(f.rows(), /symbolic link/);
  await f.clean();
});
