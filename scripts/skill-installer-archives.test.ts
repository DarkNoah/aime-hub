import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  truncate,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SkillService } from '../apps/server/src/modules/skills/service.js';

const exec = promisify(execFile);
const scripts = resolve(
  'apps/server/src/mastra/skills/skill-installer/scripts',
);
const manifest = (name: string) =>
  `---\nname: ${name}\ndescription: Archive fixture\n---\n# Use ${name}\n`;
type Entry = {
  path: string;
  content?: string;
  mode?: number;
  compression?: number;
};
const zipWriter = `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as package:
    for entry in json.loads(sys.argv[2]):
        info = zipfile.ZipInfo(entry["path"])
        info.create_system = 3
        info.external_attr = entry.get("mode", 0o100644) << 16
        info.compress_type = entry.get("compression", zipfile.ZIP_DEFLATED)
        package.writestr(info, entry.get("content", ""))
`;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'skill-installer-archives-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'workspace/users/alice/.agents/skills');
  const temporary = join(root, 'temporary');
  const bin = join(root, 'empty-bin');
  await Promise.all([mkdir(temporary), mkdir(bin)]);
  const python = (
    await exec('python3', ['-c', 'import sys; print(sys.executable)'])
  ).stdout.trim();
  const env = {
    ...process.env,
    SKILL_HOME: home,
    TMPDIR: temporary,
    PATH: bin,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  return {
    root,
    home,
    temporary,
    python: (args: string[]) => exec(python, args, { env }),
    run: (script: string, args: string[], scope = home) =>
      exec(python, [join(scripts, script), ...args], {
        cwd: root,
        env: { ...env, SKILL_HOME: scope },
      }),
    archive: async (name: string, entries: Entry[]) => {
      const path = join(root, name);
      await exec(python, ['-c', zipWriter, path, JSON.stringify(entries)], {
        env,
      });
      return path;
    },
    clean: async () => {
      assert.deepEqual(await readdir(temporary), []);
      const contents = await readdir(home).catch(() => []);
      assert.ok(
        contents.every(
          (name) =>
            !name.startsWith('.skill-archive-') &&
            !name.endsWith('.skill-install.lock'),
        ),
      );
    },
  };
}

test('local .skill root packages preview and install without Git while preserving bundled entries, bytes and executable modes', async (t) => {
  const f = await fixture(t);
  await f.archive('My Package.skill', [
    { path: 'SKILL.md', content: manifest('whole-package') },
    { path: 'scripts/run.sh', content: '#!/bin/sh\nexit 0\n', mode: 0o100755 },
    { path: 'nested/SKILL.md', content: manifest('bundled') },
    { path: 'assets/unicode.txt', content: '资源\u0000数据\n' },
    { path: '.skill-meta/source.json', content: '{"source":"resource"}' },
    { path: '.git/config', content: 'ignored' },
    { path: '__MACOSX/._SKILL.md', content: 'ignored' },
    { path: '.DS_Store', content: 'ignored' },
  ]);
  const args = ['--archive', 'My Package.skill'];
  const listing = JSON.parse(
    (await f.run('list-skills.py', [...args, '--format', 'json'])).stdout,
  );
  assert.equal(listing.length, 1);
  assert.equal(listing[0].name, 'whole-package');
  assert.deepEqual(listing[0].bundledSkills, ['nested/SKILL.md']);
  assert.equal(
    listing[0].destination,
    join(f.home, 'my-package/whole-package'),
  );
  assert.equal(
    (await f.run('list-skills.py', [...args, '--preview'])).stdout.trim(),
    manifest('whole-package').trim(),
  );
  await f.run('install-skill.py', args);
  const target = listing[0].destination;
  assert.equal(
    await readFile(join(target, 'nested/SKILL.md'), 'utf8'),
    manifest('bundled'),
  );
  assert.equal(
    await readFile(join(target, 'assets/unicode.txt'), 'utf8'),
    '资源\u0000数据\n',
  );
  assert.equal(
    (await stat(join(target, 'scripts/run.sh'))).mode & 0o777,
    0o755,
  );
  assert.deepEqual((await readdir(target)).sort(), [
    '.skill-meta',
    'SKILL.md',
    'assets',
    'nested',
    'scripts',
  ]);
  assert.deepEqual((await readdir(join(f.home, 'my-package'))).sort(), [
    '.skill-meta',
    'whole-package',
  ]);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(f.home, 'my-package/.skill-meta/.skill-archive.json'),
        'utf8',
      ),
    ),
    { version: 1 },
  );
  await assert.rejects(stat(join(f.home, '@local')), { code: 'ENOENT' });
  const installed = JSON.parse(
    (await f.run('list-skills.py', ['--format', 'json'])).stdout,
  );
  assert.equal(installed[0].path, 'my-package/whole-package');
  const service = new SkillService(join(f.root, 'workspace'));
  t.after(() => service.dispose());
  assert.deepEqual(
    (await service.forUser('alice').list()).skills.map((skill) => skill.path),
    ['my-package/whole-package'],
  );
  await f.clean();
});

test('wrapped collections keep archive paths, support scoped batch imports and preserve existing destinations', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('collection.ZIP', [
    {
      path: 'wrapper/catalog/alpha/SKILL.md',
      content: manifest('display-alpha'),
    },
    { path: 'wrapper/catalog/alpha/refs/guide.txt', content: 'alpha guide' },
    { path: 'wrapper/catalog/beta/SKILL.md', content: manifest('beta') },
  ]);
  const args = ['--archive', archive];
  const listing = JSON.parse(
    (await f.run('list-skills.py', [...args, '--format', 'json'])).stdout,
  );
  assert.deepEqual(
    listing.map((row: { name: string }) => row.name),
    ['alpha', 'beta'],
  );
  await f.run('install-skill.py', [...args, '--path', 'wrapper/catalog/alpha']);
  await assert.rejects(f.run('install-skill.py', args), /already exists/);
  assert.deepEqual((await readdir(join(f.home, 'collection'))).sort(), [
    '.skill-meta',
    'alpha',
  ]);
  await f.run('install-skill.py', [
    ...args,
    '--path',
    'wrapper/catalog/beta/SKILL.md',
  ]);
  assert.deepEqual((await readdir(join(f.home, 'collection'))).sort(), [
    '.skill-meta',
    'alpha',
    'beta',
  ]);
  assert.equal(
    await readFile(join(f.home, 'collection/alpha/refs/guide.txt'), 'utf8'),
    'alpha guide',
  );
  const project = join(f.root, 'workspace/projects/project/.agents/skills');
  await f.run('install-skill.py', args, project);
  assert.deepEqual((await readdir(join(project, 'collection'))).sort(), [
    '.skill-meta',
    'alpha',
    'beta',
  ]);
  await f.clean();
});

test('an outer package retains its nested resources and is installed as one directory', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('outer.zip', [
    { path: 'wrapped/SKILL.md', content: manifest('display-name') },
    { path: 'wrapped/child/SKILL.md', content: manifest('child') },
    { path: 'wrapped/shared.py', content: '# shared' },
  ]);
  await f.run('install-skill.py', ['--archive', archive]);
  assert.deepEqual((await readdir(join(f.home, 'outer'))).sort(), [
    '.skill-meta',
    'wrapped',
  ]);
  assert.equal(
    await readFile(join(f.home, 'outer/wrapped/child/SKILL.md'), 'utf8'),
    manifest('child'),
  );
  await f.clean();
});

test('management imports and Python archive installs recognize each other and share the same destinations', async (t) => {
  const f = await fixture(t);
  const name = 'Shared Archive.skill';
  const archive = await f.archive(name, [
    { path: 'wrapped/alpha/SKILL.md', content: manifest('alpha') },
    { path: 'wrapped/beta/SKILL.md', content: manifest('beta') },
  ]);
  await f.run('install-skill.py', [
    '--archive',
    archive,
    '--path',
    'wrapped/alpha',
  ]);
  const service = new SkillService(join(f.root, 'workspace'));
  t.after(() => service.dispose());
  const personal = service.forUser('alice');
  const scan = await personal.scanArchive(name, await readFile(archive));
  assert.deepEqual(
    scan.skills.map((skill) => [skill.destination, skill.installed]),
    [
      ['shared-archive/alpha', true],
      ['shared-archive/beta', false],
    ],
  );
  const installed = await personal.install(scan.id, ['wrapped/beta/SKILL.md']);
  assert.equal(installed[0].path, 'shared-archive/beta');
  const listing = JSON.parse(
    (await f.run('list-skills.py', ['--archive', archive, '--format', 'json']))
      .stdout,
  );
  assert.deepEqual(
    listing.map((row: { installed: boolean }) => row.installed),
    [true, true],
  );
  assert.deepEqual((await readdir(join(f.home, 'shared-archive'))).sort(), [
    '.skill-meta',
    'alpha',
    'beta',
  ]);
  assert.deepEqual(
    (await personal.list()).skills.map((skill) => skill.path),
    ['shared-archive/alpha', 'shared-archive/beta'],
  );
  await f.clean();
});

test('unsafe paths, links, special files, duplicate paths and file-directory conflicts fail before installing', async (t) => {
  const f = await fixture(t);
  const cases: Entry[][] = [
    [{ path: '../escape', content: 'unsafe' }],
    [{ path: '/absolute', content: 'unsafe' }],
    [{ path: 'C:/drive', content: 'unsafe' }],
    [{ path: 'folder\\unsafe', content: 'unsafe' }],
    [{ path: 'control\u0001', content: 'unsafe' }],
    [{ path: 'linked', content: '/etc/passwd', mode: 0o120777 }],
    [{ path: 'device', mode: 0o020600 }],
    [{ path: 'duplicate' }, { path: 'duplicate' }],
    [{ path: 'Asset/file' }, { path: 'asset/other' }],
    [{ path: 'resource' }, { path: 'resource/file' }],
  ];
  for (const [index, entries] of cases.entries()) {
    const archive = await f.archive(`bad-${index}.zip`, [
      { path: 'SKILL.md', content: manifest('root') },
      ...entries,
    ]);
    await assert.rejects(
      f.run('install-skill.py', ['--archive', archive]),
      /unsafe path|unsupported file type|conflicting paths/,
    );
    await f.clean();
  }
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('empty, unsupported, encrypted and corrupted packages and invalid options return readable errors', async (t) => {
  const f = await fixture(t);
  const empty = await f.archive('empty.zip', []);
  await assert.rejects(f.run('list-skills.py', ['--archive', empty]), /empty/);
  const noManifest = await f.archive('no-manifest.zip', [
    { path: 'README.md' },
  ]);
  await assert.rejects(
    f.run('install-skill.py', ['--archive', noManifest]),
    /No SKILL.md/,
  );
  const unsupported = await f.archive('bzip.zip', [
    { path: 'SKILL.md', content: manifest('root'), compression: 12 },
  ]);
  await assert.rejects(
    f.run('install-skill.py', ['--archive', unsupported]),
    /unsupported compression/,
  );
  const valid = await f.archive('source.zip', [
    { path: 'SKILL.md', content: manifest('root'), compression: 0 },
  ]);
  const bytes = await readFile(valid);
  const encrypted = Buffer.from(bytes);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  const encryptedPath = join(f.root, 'encrypted.zip');
  await writeFile(encryptedPath, encrypted);
  await assert.rejects(
    f.run('install-skill.py', ['--archive', encryptedPath]),
    /Encrypted/,
  );
  const corrupted = Buffer.from(bytes);
  corrupted[30 + corrupted.readUInt16LE(26) + corrupted.readUInt16LE(28)] ^= 1;
  const corruptPath = join(f.root, 'corrupt.skill');
  await writeFile(corruptPath, corrupted);
  await assert.rejects(
    f.run('install-skill.py', ['--archive', corruptPath]),
    /damaged/,
  );
  await assert.rejects(
    f.run('install-skill.py', ['--archive', valid, '--ref', 'main']),
    /--ref cannot/,
  );
  await assert.rejects(
    f.run('install-skill.py', ['--archive', valid, '--path', 'missing']),
    /No skills/,
  );
  await assert.rejects(
    f.run('list-skills.py', ['--archive', 'unknown.txt']),
    /\.zip or \.skill/,
  );
  await f.clean();
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('compressed, expanded-size and entry-count limits reject archives before writing destinations', async (t) => {
  const f = await fixture(t);
  const large = join(f.root, 'large.zip');
  await writeFile(large, '');
  await truncate(large, 100 * 1024 * 1024 + 1);
  await assert.rejects(
    f.run('install-skill.py', ['--archive', large]),
    /100 MiB/,
  );
  const expanded = await f.archive('expanded.zip', [
    { path: 'SKILL.md', content: manifest('root') },
  ]);
  const bytes = await readFile(expanded);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(512 * 1024 * 1024 + 1, central + 24);
  await writeFile(expanded, bytes);
  await assert.rejects(
    f.run('install-skill.py', ['--archive', expanded]),
    /512 MiB/,
  );
  const many = join(f.root, 'many.zip');
  await f.python([
    '-c',
    'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as package:\n    for i in range(10001): package.writestr(str(i), "")',
    many,
  ]);
  await assert.rejects(
    f.run('install-skill.py', ['--archive', many]),
    /10,000-entry/,
  );
  await f.clean();
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('forged smaller output sizes cannot hide extra stored or deflated data even with a matching prefix CRC', async (t) => {
  const f = await fixture(t);
  for (const compression of [0, 8]) {
    const archive = await f.archive(`forged-${compression}.zip`, [
      { path: 'SKILL.md', content: manifest('root'), compression },
    ]);
    await f.python([
      '-c',
      `import pathlib, struct, sys, zlib
path = pathlib.Path(sys.argv[1])
data = bytearray(path.read_bytes())
central = data.index(b"PK\\x01\\x02")
crc = zlib.crc32(b"---\\n")
struct.pack_into("<I", data, 14, crc)
struct.pack_into("<I", data, 22, 4)
struct.pack_into("<I", data, central + 16, crc)
struct.pack_into("<I", data, central + 24, 4)
path.write_bytes(data)
`,
      archive,
    ]);
    await assert.rejects(
      f.run('install-skill.py', ['--archive', archive]),
      /declared size/,
    );
  }
  await f.clean();
  await assert.rejects(stat(f.home), { code: 'ENOENT' });
});

test('a failed archive commit rolls back newly installed directories and preserves prior skills', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive(
    'batch.skill',
    ['alpha', 'beta', 'existing'].map((name) => ({
      path: `${name}/SKILL.md`,
      content: manifest(name),
    })),
  );
  await f.run('install-skill.py', ['--archive', archive, '--path', 'existing']);
  const code = `import importlib.util, pathlib, sys
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]) / "install-skill.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
rename = pathlib.Path.rename
def fail(self, target):
    if pathlib.Path(target).name == "beta": raise OSError("injected commit failure")
    return rename(self, target)
pathlib.Path.rename = fail
with installer.archive(sys.argv[2]) as snapshot:
    try: installer.install(installer.skill_home(), snapshot, ["alpha", "beta"])
    except OSError as exc: assert str(exc) == "injected commit failure"
    else: raise AssertionError("expected failure")
`;
  await f.python(['-c', code, scripts, archive]);
  assert.deepEqual((await readdir(join(f.home, 'batch'))).sort(), [
    '.skill-meta',
    'existing',
  ]);
  assert.equal(
    await readFile(join(f.home, 'batch/existing/SKILL.md'), 'utf8'),
    manifest('existing'),
  );
  await f.clean();
});

test('new archive groups publish their marker atomically and restore an existing empty destination after failure', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('atomic.skill', [
    { path: 'SKILL.md', content: manifest('root') },
  ]);
  const group = join(f.home, 'atomic');
  const code = `import importlib.util, pathlib, sys
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]) / "install-skill.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
rename = pathlib.Path.rename
def fail(self, target):
    if self.name == "next": raise OSError("injected group publication failure")
    return rename(self, target)
pathlib.Path.rename = fail
with installer.archive(sys.argv[2]) as snapshot:
    try: installer.install(installer.skill_home(), snapshot, None)
    except OSError as error: assert str(error) == "injected group publication failure"
    else: raise AssertionError("expected failure")
`;
  await f.python(['-c', code, scripts, archive]);
  await assert.rejects(stat(group), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.home), []);
  await mkdir(group);
  await f.python(['-c', code, scripts, archive]);
  assert.deepEqual(await readdir(group), []);
  await f.clean();
  await f.run('install-skill.py', ['--archive', archive]);
  assert.deepEqual((await readdir(group)).sort(), ['.skill-meta', 'root']);
  assert.deepEqual(
    JSON.parse(
      await readFile(join(group, '.skill-meta/.skill-archive.json'), 'utf8'),
    ),
    { version: 1 },
  );
  await f.clean();
});

test('legacy ordinary archive installations require service migration without creating duplicate flat groups', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('legacy.zip', [
    { path: 'alpha/SKILL.md', content: manifest('alpha') },
  ]);
  const oldSkill = join(f.home, '@local/legacy/alpha');
  await mkdir(oldSkill, { recursive: true });
  await writeFile(join(oldSkill, 'SKILL.md'), manifest('alpha'));
  for (const args of [
    ['--archive', archive],
    ['--archive', archive, '--whole-project'],
  ]) {
    await assert.rejects(
      f.run('list-skills.py', args),
      /Restart the application service/,
    );
    await assert.rejects(
      f.run('install-skill.py', args),
      /Restart the application service/,
    );
  }
  const installed = JSON.parse(
    (await f.run('list-skills.py', ['--format', 'json'])).stdout,
  );
  assert.deepEqual(
    installed.map((skill: { path: string }) => skill.path),
    ['@local/legacy/alpha'],
  );
  assert.equal(
    await readFile(join(oldSkill, 'SKILL.md'), 'utf8'),
    manifest('alpha'),
  );
  await assert.rejects(stat(join(f.home, 'legacy')), { code: 'ENOENT' });
  await f.clean();
});

test('archive markers protect GitHub owner namespaces in both directions and reject mixed installation metadata', async (t) => {
  const f = await fixture(t);
  const archive = await f.archive('owner.zip', [
    { path: 'alpha/SKILL.md', content: manifest('alpha') },
  ]);
  const existing = join(f.home, 'owner/repo/existing');
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'SKILL.md'), manifest('existing'));
  await assert.rejects(
    f.run('install-skill.py', ['--archive', archive]),
    /not an archive skill group/,
  );
  assert.equal(
    await readFile(join(existing, 'SKILL.md'), 'utf8'),
    manifest('existing'),
  );
  await rm(join(f.home, 'owner'), { recursive: true });
  await f.run('install-skill.py', ['--archive', archive]);
  const code = `import importlib.util, pathlib, sys
sys.path.insert(0, sys.argv[1])
from repository import Source, SkillError
spec = importlib.util.spec_from_file_location("installer", pathlib.Path(sys.argv[1]) / "install-skill.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
with installer.archive(sys.argv[2]) as snapshot:
    snapshot.source = Source("owner", "repo", "https://github.com/owner/repo")
    for whole in [False, True]:
        try: installer.install(installer.skill_home(), snapshot, None, whole)
        except SkillError as error: assert "archive skill group" in str(error)
        else: raise AssertionError("archive group cannot be a repository owner")
`;
  await f.python(['-c', code, scripts, archive]);
  await assert.rejects(stat(join(f.home, 'owner/repo')), { code: 'ENOENT' });
  const metadata = join(f.home, 'owner/.skill-meta');
  await writeFile(
    join(metadata, '.skill-project.json'),
    JSON.stringify({
      version: 2,
      root: '.',
      entries: [{ path: 'alpha/SKILL.md', name: 'alpha' }],
    }),
  );
  await assert.rejects(
    f.run('list-skills.py', ['--format', 'json']),
    /Invalid archive installation record/,
  );
  await assert.rejects(
    f.run('install-skill.py', ['--archive', archive]),
    /Invalid archive installation record/,
  );
  await f.clean();
});
