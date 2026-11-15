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
    clean: async () => assert.deepEqual(await readdir(temporary), []),
  };
}

test('local .skill root packages preview and install without Git while preserving bundled entries, bytes and executable modes', async (t) => {
  const f = await fixture(t);
  await f.archive('My Package.skill', [
    { path: 'SKILL.md', content: manifest('whole-package') },
    { path: 'scripts/run.sh', content: '#!/bin/sh\nexit 0\n', mode: 0o100755 },
    { path: 'nested/SKILL.md', content: manifest('bundled') },
    { path: 'assets/unicode.txt', content: '资源\u0000数据\n' },
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
    join(f.home, '@local/my-package/whole-package'),
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
    'SKILL.md',
    'assets',
    'nested',
    'scripts',
  ]);
  assert.deepEqual(await readdir(join(f.home, '@local/my-package')), [
    'whole-package',
  ]);
  const installed = JSON.parse(
    (await f.run('list-skills.py', ['--format', 'json'])).stdout,
  );
  assert.equal(installed[0].path, '@local/my-package/whole-package');
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
  assert.deepEqual(await readdir(join(f.home, '@local/collection')), ['alpha']);
  await f.run('install-skill.py', [
    ...args,
    '--path',
    'wrapper/catalog/beta/SKILL.md',
  ]);
  assert.deepEqual((await readdir(join(f.home, '@local/collection'))).sort(), [
    'alpha',
    'beta',
  ]);
  assert.equal(
    await readFile(
      join(f.home, '@local/collection/alpha/refs/guide.txt'),
      'utf8',
    ),
    'alpha guide',
  );
  const project = join(f.root, 'workspace/projects/project/.agents/skills');
  await f.run('install-skill.py', args, project);
  assert.deepEqual((await readdir(join(project, '@local/collection'))).sort(), [
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
  assert.deepEqual(await readdir(join(f.home, '@local/outer')), ['wrapped']);
  assert.equal(
    await readFile(join(f.home, '@local/outer/wrapped/child/SKILL.md'), 'utf8'),
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
      ['@local/shared-archive/alpha', true],
      ['@local/shared-archive/beta', false],
    ],
  );
  const installed = await personal.install(scan.id, ['wrapped/beta/SKILL.md']);
  assert.equal(installed[0].path, '@local/shared-archive/beta');
  const listing = JSON.parse(
    (await f.run('list-skills.py', ['--archive', archive, '--format', 'json']))
      .stdout,
  );
  assert.deepEqual(
    listing.map((row: { installed: boolean }) => row.installed),
    [true, true],
  );
  assert.deepEqual(
    (await readdir(join(f.home, '@local/shared-archive'))).sort(),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    (await personal.list()).skills.map((skill) => skill.path),
    ['@local/shared-archive/alpha', '@local/shared-archive/beta'],
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
  assert.deepEqual(await readdir(join(f.home, '@local/batch')), ['existing']);
  assert.equal(
    await readFile(join(f.home, '@local/batch/existing/SKILL.md'), 'utf8'),
    manifest('existing'),
  );
  await f.clean();
});
