import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { syncBuiltinSkills } from '../apps/server/src/modules/skills/builtin.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';

const exec = promisify(execFile);
const manifest = (name: string, description = 'Bundled fixture') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\n`;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'builtin-skills-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const workspace = join(root, 'workspace');
  const global = join(workspace, '.agents/skills');
  const builtin = join(global, 'builtin');
  await mkdir(source);
  const write = async (path: string, content: string | Buffer) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const add = async (path: string, description?: string) =>
    write(
      join(source, path, 'SKILL.md'),
      manifest(path.split('/').at(-1)!, description),
    );
  return {
    root,
    source,
    workspace,
    global,
    builtin,
    write,
    add,
    sync: () => syncBuiltinSkills(source, workspace),
  };
}

test('startup copies complete skill packages into a global group visible to management and both chat scopes', async (t) => {
  const f = await fixture(t);
  await f.add('installer');
  await f.add('tools/review');
  await f.write(
    join(f.source, 'installer/scripts/run.sh'),
    '#!/bin/sh\nexit 0\n',
  );
  await chmod(join(f.source, 'installer/scripts/run.sh'), 0o755);
  await f.write(
    join(f.source, 'installer/assets/data.bin'),
    Buffer.from([0, 255, 1]),
  );
  await f.write(
    join(f.source, 'installer/references/sample/SKILL.md'),
    manifest('example-only'),
  );
  await f.write(join(f.source, 'loose/notes.md'), 'Not a skill');
  await f.write(join(f.source, '.hidden/SKILL.md'), manifest('hidden'));
  const result = await f.sync();
  assert.deepEqual(result, { count: 2, directory: f.builtin });
  assert.deepEqual(
    await readFile(join(f.builtin, 'installer/assets/data.bin')),
    Buffer.from([0, 255, 1]),
  );
  assert.equal(
    (await lstat(join(f.builtin, 'installer/scripts/run.sh'))).mode & 0o777,
    0o755,
  );
  assert.deepEqual((await readdir(f.builtin)).sort(), ['installer', 'tools']);
  const service = new SkillService(f.workspace);
  t.after(() => service.dispose());
  assert.deepEqual(
    (await service.list()).skills.map((skill) => skill.path).sort(),
    ['builtin/installer', 'builtin/tools/review'],
  );
  for (const project of [undefined, 'abcdefghijklmnop']) {
    const skills = await listChatSkills(f.workspace, 'user', project);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ['installer', 'review'],
    );
  }
});

test('restart refreshes bundled content and removes retired packages while retaining independently installed skills', async (t) => {
  const f = await fixture(t);
  await f.add('installer');
  await f.add('retired');
  await f.write(join(f.source, 'installer/old.txt'), 'old');
  const external = [
    join(f.global, 'owner/repo/custom/SKILL.md'),
    join(f.workspace, 'users/user/.agents/skills/installer/SKILL.md'),
    join(
      f.workspace,
      'projects/abcdefghijklmnop/.agents/skills/project/SKILL.md',
    ),
  ];
  for (const file of external)
    await f.write(file, manifest('custom', 'User content'));
  await f.sync();
  await rm(join(f.source, 'retired'), { recursive: true });
  await rm(join(f.source, 'installer/old.txt'));
  await f.add('installer', 'Updated built-in');
  await f.add('new-skill');
  await f.sync();
  assert.equal(
    await readFile(join(f.builtin, 'installer/SKILL.md'), 'utf8'),
    manifest('installer', 'Updated built-in'),
  );
  assert.deepEqual(await readdir(join(f.builtin, 'installer')), ['SKILL.md']);
  assert.deepEqual((await readdir(f.builtin)).sort(), [
    'installer',
    'new-skill',
  ]);
  for (const file of external)
    assert.equal(
      await readFile(file, 'utf8'),
      manifest('custom', 'User content'),
    );
  const catalog = await listChatSkills(f.workspace, 'user');
  assert.equal(
    catalog.find((skill) => skill.name === 'installer')?.description,
    'User content',
  );
  await f.sync();
  assert.deepEqual((await readdir(f.global)).sort(), ['builtin', 'owner']);
});

test('an empty bundle removes obsolete built-ins and leaves other global groups intact', async (t) => {
  const f = await fixture(t);
  await f.add('retired');
  await f.write(
    join(f.global, 'owner/repo/custom/SKILL.md'),
    manifest('custom'),
  );
  await f.sync();
  await rm(join(f.source, 'retired'), { recursive: true });
  assert.equal((await f.sync()).count, 0);
  assert.deepEqual(await readdir(f.builtin), []);
  assert.equal(
    await readFile(join(f.global, 'owner/repo/custom/SKILL.md'), 'utf8'),
    manifest('custom'),
  );
});

test('a failed staged copy preserves the prior bundle and removes staging directories', async (t) => {
  const f = await fixture(t);
  await f.add('installer', 'Previous version');
  await f.sync();
  await f.add('installer', 'New version');
  // A special file cannot be copied as a regular bundled asset.
  await exec('mkfifo', [join(f.source, 'installer/unsupported-pipe')]);
  await assert.rejects(f.sync());
  assert.equal(
    await readFile(join(f.builtin, 'installer/SKILL.md'), 'utf8'),
    manifest('installer', 'Previous version'),
  );
  assert.deepEqual(await readdir(f.global), ['builtin']);
});

test('missing source assets fail before replacing previously installed built-ins', async (t) => {
  const f = await fixture(t);
  await f.add('installer');
  await f.sync();
  await rm(f.source, { recursive: true });
  await assert.rejects(f.sync(), /Bundled skills directory is missing/);
  assert.equal(
    await readFile(join(f.builtin, 'installer/SKILL.md'), 'utf8'),
    manifest('installer'),
  );
});

test('source links are skipped and workspace links cannot redirect writes', async (t) => {
  const f = await fixture(t);
  await f.add('installer');
  await f.write(join(f.source, 'installer/.DS_Store'), 'metadata');
  await f.write(join(f.source, 'installer/__pycache__/module.pyc'), 'cache');
  await symlink(f.source, join(f.source, 'linked-package'));
  await symlink('/etc/passwd', join(f.source, 'installer/external'));
  await f.sync();
  assert.deepEqual(await readdir(f.builtin), ['installer']);
  assert.deepEqual(await readdir(join(f.builtin, 'installer')), ['SKILL.md']);
  await rm(f.builtin, { recursive: true });
  await symlink(f.source, f.builtin);
  await assert.rejects(f.sync(), /Invalid built-in skills directory/);
  await rm(f.builtin);
  await rm(f.global, { recursive: true });
  await symlink(f.source, f.global);
  await assert.rejects(f.sync(), /Invalid global skills directory/);
  assert.equal(
    await readFile(join(f.source, 'installer/SKILL.md'), 'utf8'),
    manifest('installer'),
  );
});

test('the actual bundled installer is discovered and all of its runtime scripts are copied', async (t) => {
  const f = await fixture(t);
  await syncBuiltinSkills(
    resolve('apps/server/src/mastra/skills'),
    f.workspace,
  );
  const skills = await listChatSkills(f.workspace, 'user');
  assert.ok(skills.some((skill) => skill.name === 'skill-installer'));
  const scripts = ['install-skill.py', 'list-skills.py', 'repository.py'];
  for (const script of scripts) {
    assert.equal(
      await readFile(
        join(f.builtin, 'skill-installer/scripts', script),
        'utf8',
      ),
      await readFile(
        resolve(
          'apps/server/src/mastra/skills/skill-installer/scripts',
          script,
        ),
        'utf8',
      ),
    );
  }
});
