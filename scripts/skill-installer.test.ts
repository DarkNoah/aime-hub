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
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSkillSources } from '../apps/server/src/modules/skills/sources.js';
import { listChatSkills } from '../apps/server/src/modules/threads/skills.js';

const exec = promisify(execFile);
const scripts = resolve(
  'apps/server/src/mastra/skills/skill-installer/scripts',
);
const remote = 'https://github.com/owner/repo.git';
const proxies = ['https://githubproxy.cc/', 'https://ghfast.top/'].map(
  (prefix) => prefix + remote,
);
const manifest = (name: string) =>
  `---\nname: ${name}\ndescription: Fixture instructions\n---\n# Use ${name}\n`;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'skill-installer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'source');
  const bin = join(root, 'bin');
  const downloads = join(root, 'downloads');
  const calls = join(root, 'calls.jsonl');
  const control = join(root, 'control.json');
  for (const path of [
    bin,
    downloads,
    join(repo, 'catalog/alpha'),
    join(repo, 'catalog/beta'),
  ])
    await mkdir(path, { recursive: true });
  await writeFile(join(repo, 'catalog/alpha/SKILL.md'), manifest('alpha'));
  await writeFile(join(repo, 'catalog/beta/SKILL.md'), manifest('beta'));
  await writeFile(join(repo, 'catalog/alpha/run.sh'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  await writeFile(
    join(repo, 'catalog/alpha/resource.bin'),
    Buffer.from([0, 255, 13, 10]),
  );
  await symlink('/etc/passwd', join(repo, 'catalog/alpha/link'));
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
  await git('branch', 'feature/skills');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  const failingBlob = (
    await git('rev-parse', 'HEAD:catalog/beta/SKILL.md')
  ).stdout.trim();
  await writeFile(control, '{}');
  await writeFile(calls, '');
  await writeFile(
    join(bin, 'git'),
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const remote = args.find(arg => arg.startsWith('https://'));
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, remote }) + '\n');
if (control.failedRemotes?.includes(remote) || control.failingBlob && args.includes(control.failingBlob)) process.exit(128);
const localArgs = args.map(arg => arg === remote ? ${JSON.stringify(repo)} : arg);
const result = spawnSync('git', ['-c', 'protocol.file.allow=always', ...localArgs], { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} }, stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  const workspace = join(root, 'workspace');
  const home = join(workspace, 'users/user/.agents/skills');
  const python = (args: string[], scope = home) =>
    exec('python3', args, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TMPDIR: downloads,
        SKILL_HOME: scope,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
  const run = (script: string, args: string[] = [], scope = home) =>
    python([join(scripts, script), ...args], scope);
  return {
    root,
    repo,
    home,
    workspace,
    commit,
    failingBlob,
    run,
    python,
    control: (value: object) => writeFile(control, JSON.stringify(value)),
    calls: async () =>
      (await readFile(calls, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row) as { args: string[]; remote?: string }),
    clean: async () => {
      assert.deepEqual(await readdir(downloads), []);
      const group = join(home, 'owner/repo');
      const entries = await readdir(group).catch(() => []);
      assert.ok(entries.every((entry) => !entry.startsWith('.skill-install')));
    },
  };
}

test('skill script installs into the personal scope, preserves resources and interoperates with the catalog and source metadata', async (t) => {
  const f = await fixture(t);
  const listing = JSON.parse(
    (
      await f.run('list-skills.py', [
        '--repo',
        'owner/repo',
        '--format',
        'json',
      ])
    ).stdout,
  );
  assert.deepEqual(
    listing.map((row: { name: string }) => row.name),
    ['alpha', 'beta'],
  );
  assert.equal(
    (
      await f.run('list-skills.py', [
        '--repo',
        'owner/repo',
        '--path',
        'catalog/alpha',
        '--preview',
      ])
    ).stdout.trim(),
    manifest('alpha').trim(),
  );
  await f.run('install-skill.py', [
    '--repo',
    'owner/repo',
    '--path',
    'catalog/alpha',
  ]);
  const target = join(f.home, 'owner/repo/alpha');
  assert.equal(
    await readFile(join(target, 'SKILL.md'), 'utf8'),
    manifest('alpha'),
  );
  assert.deepEqual(
    await readFile(join(target, 'resource.bin')),
    Buffer.from([0, 255, 13, 10]),
  );
  assert.ok(!(await readdir(target)).includes('link'));
  assert.ok(!(await readdir(target)).includes('.git'));
  assert.deepEqual(await readSkillSources(join(f.home, 'owner/repo')), [
    {
      url: 'https://github.com/owner/repo/tree/main/catalog/alpha',
      ref: 'main',
      scope: 'catalog/alpha',
    },
  ]);
  const installed = JSON.parse(
    (await f.run('list-skills.py', ['--format', 'json'])).stdout,
  );
  assert.deepEqual(
    installed.map((row: { path: string }) => row.path),
    ['owner/repo/alpha'],
  );
  const catalog = await listChatSkills(f.workspace, 'user');
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.name, 'alpha');
  await f.clean();
});

test('project installs honor SKILL_HOME and retain the original slash branch and parent scope', async (t) => {
  const f = await fixture(t);
  const project = join(f.workspace, 'projects/abcdefghijklmnop/.agents/skills');
  await f.run(
    'install-skill.py',
    ['--url', 'https://github.com/owner/repo/tree/feature/skills/catalog'],
    project,
  );
  assert.equal(
    (await readSkillSources(join(project, 'owner/repo')))[0]?.scope,
    'catalog',
  );
  assert.equal(
    (await readSkillSources(join(project, 'owner/repo')))[0]?.ref,
    'feature/skills',
  );
  const installed = JSON.parse(
    (await f.run('list-skills.py', ['--format', 'json'], project)).stdout,
  );
  assert.equal(installed.length, 2);
  assert.deepEqual(
    JSON.parse((await f.run('list-skills.py', ['--format', 'json'])).stdout),
    [],
  );
  await f.clean();
});

test('source records are merged and a conflicting batch leaves prior skills and metadata untouched', async (t) => {
  const f = await fixture(t);
  await f.run('install-skill.py', [
    '--repo',
    'owner/repo',
    '--path',
    'catalog/alpha',
  ]);
  const group = join(f.home, 'owner/repo');
  const before = await readFile(join(group, '.skill-sources.json'), 'utf8');
  await assert.rejects(
    f.run('install-skill.py', ['--repo', 'owner/repo', '--path', 'catalog']),
    /already exists/,
  );
  assert.equal(
    await readFile(join(group, '.skill-sources.json'), 'utf8'),
    before,
  );
  assert.deepEqual((await readdir(group)).sort(), [
    '.skill-sources.json',
    'alpha',
  ]);
  await f.run('install-skill.py', [
    '--repo',
    'owner/repo',
    '--path',
    'catalog/beta',
  ]);
  assert.equal((await readSkillSources(group)).length, 2);
  await f.clean();
});

test('direct and proxy failures retry in order and retain the original source', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [remote, proxies[0]] });
  await f.run('install-skill.py', ['--repo', 'owner/repo']);
  assert.deepEqual(
    (await f.calls()).filter((call) => call.remote).map((call) => call.remote),
    [remote, ...proxies],
  );
  assert.deepEqual(await readSkillSources(join(f.home, 'owner/repo')), [
    { url: 'https://github.com/owner/repo', ref: null, scope: '' },
  ]);
  await f.clean();
});

test('missing source paths and preview ambiguity never install anything', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run('install-skill.py', [
      '--url',
      'https://github.com/owner/repo/tree/main/missing',
    ]),
    /path no longer exists/,
  );
  await assert.rejects(
    f.run('list-skills.py', ['--repo', 'owner/repo', '--preview']),
    /exactly one/,
  );
  await assert.rejects(
    f.run('install-skill.py', [
      '--url',
      'https://github.com/owner/repo/tree/main/catalog/alpha',
      '--path',
      'catalog/beta',
    ]),
    /outside the source/,
  );
  assert.ok(
    (await f.calls())
      .filter((call) => call.remote)
      .every((call) => call.remote === remote),
  );
  assert.deepEqual(
    JSON.parse((await f.run('list-skills.py', ['--format', 'json'])).stdout),
    [],
  );
  await f.clean();
});

test('download or staged-copy failure cleans temporary files without a partially installed batch', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [remote, ...proxies] });
  await assert.rejects(
    f.run('install-skill.py', ['--repo', 'owner/repo']),
    /transfer failed/,
  );
  await f.clean();
  await f.control({ failingBlob: f.failingBlob });
  await assert.rejects(
    f.run('install-skill.py', ['--repo', 'owner/repo']),
    /transfer failed/,
  );
  assert.deepEqual(
    JSON.parse((await f.run('list-skills.py', ['--format', 'json'])).stdout),
    [],
  );
  await f.clean();
});

test('missing or unsafe destinations are rejected without writing to another scope', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run('install-skill.py', ['--repo', 'owner/repo'], ''),
    /SKILL_HOME/,
  );
  await assert.rejects(
    f.run('install-skill.py', ['--repo', 'owner/repo'], 'relative'),
    /SKILL_HOME/,
  );
  assert.equal((await f.calls()).length, 0);
  await mkdir(f.home, { recursive: true });
  await symlink(f.repo, join(f.home, 'owner'));
  await assert.rejects(
    f.run('install-skill.py', ['--repo', 'owner/repo']),
    /symbolic link/,
  );
  await assert.rejects(
    f.run('install-skill.py', ['--repo', 'owner/repo', '--path', '../source']),
    /safe repository-relative/,
  );
  await f.clean();
});

test('full commit and manifest URLs keep bundled files and exact installation scope', async (t) => {
  const f = await fixture(t);
  await f.run('install-skill.py', [
    '--url',
    `https://github.com/owner/repo/blob/${f.commit}/catalog/alpha/SKILL.md`,
  ]);
  const source = (await readSkillSources(join(f.home, 'owner/repo')))[0];
  assert.equal(source?.ref, f.commit);
  assert.equal(source?.scope, 'catalog/alpha/SKILL.md');
  assert.equal(
    await readFile(join(f.home, 'owner/repo/alpha/run.sh'), 'utf8'),
    '#!/bin/sh\nexit 0\n',
  );
  await f.clean();
});

for (const interruption of ['write-error', 'sigterm']) {
  test(`skill batch rolls back committed folders after ${interruption}`, async (t) => {
    const f = await fixture(t);
    const code = `
import importlib.util
import os
from pathlib import Path
import signal
import sys
from unittest.mock import patch
sys.path.insert(0, ${JSON.stringify(scripts)})
spec = importlib.util.spec_from_file_location('installer', str(Path(${JSON.stringify(scripts)}) / 'install-skill.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
installer.handle_termination()
original = Path.rename
def fail_second(source, target):
    if source.name == 'beta':
        if ${JSON.stringify(interruption)} == 'sigterm':
            os.kill(os.getpid(), signal.SIGTERM)
        raise OSError('simulated destination write failure')
    return original(source, target)
with patch.object(Path, 'rename', fail_second):
    sys.exit(installer.main(['--repo', 'owner/repo']))
`;
    await assert.rejects(
      f.python(['-c', code]),
      interruption === 'sigterm'
        ? /cancelled/
        : /simulated destination write failure/,
    );
    assert.deepEqual(
      JSON.parse((await f.run('list-skills.py', ['--format', 'json'])).stdout),
      [],
    );
    assert.deepEqual(await readdir(join(f.home, 'owner/repo')), []);
    await f.clean();
  });
}
