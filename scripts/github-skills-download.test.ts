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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  downloadGitHubRepository,
  parseGitHubRepository,
} from '../apps/server/src/modules/skills/github.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';

const exec = promisify(execFile);
const source = 'https://github.com/owner/repo.git';
const firstProxy = `https://githubproxy.cc/${source}`;
const secondProxy = `https://ghfast.top/${source}`;
const content =
  '---\nname: example\ndescription: Download fixture\n---\n# Instructions\n';
type Call = { command: string; remote?: string; args: string[]; cwd: string };
type Control = {
  failedRemotes?: string[];
  failCommand?: string;
  hang?: boolean;
};

// Exercise real Git clones and object reads against a local repository, while controlling only the transport.
async function fixture(t: test.TestContext, unsafe = false) {
  const root = await mkdtemp(join(tmpdir(), 'github-skill-transport-'));
  const repo = join(root, 'upstream');
  const bin = join(root, 'bin');
  const downloads = join(root, 'downloads');
  const controlPath = join(root, 'control.json');
  const callsPath = join(root, 'calls.jsonl');
  const originalPath = process.env.PATH;
  const originalTmp = process.env.TMPDIR;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(repo, 'catalog/example'), { recursive: true });
  await mkdir(bin);
  await mkdir(downloads);
  await writeFile(join(repo, 'catalog/example/SKILL.md'), content);
  await writeFile(join(repo, 'catalog/example/guide.txt'), 'Bundled resource');
  if (unsafe) await writeFile(join(repo, 'unsafe\\path.txt'), 'unsafe');
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
  await writeFile(controlPath, '{}');
  await writeFile(callsPath, '');
  await writeFile(
    join(bin, 'git'),
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const command = args.find(arg => ['clone', 'fetch', 'init', 'ls-remote', 'rev-parse', 'ls-tree', 'cat-file'].includes(arg));
const remote = args.find(arg => arg.startsWith('https://'));
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command, remote, args, cwd: process.cwd() }) + '\n');
const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
if (remote && control.failedRemotes?.includes(remote) && (!control.failCommand || control.failCommand === command)) {
  if (command === 'clone') {
    fs.mkdirSync(args.at(-1), { recursive: true });
    fs.writeFileSync(args.at(-1) + '/partial-download', 'must be cleaned');
  }
  if (control.hang) setInterval(() => {}, 1000);
  else process.exit(128);
} else {
  const localArgs = args.map(arg => arg === remote ? ${JSON.stringify(repo)} : arg);
  const child = spawnSync('git', ['-c', 'protocol.file.allow=always', ...localArgs], { env: { ...process.env, PATH: ${JSON.stringify(originalPath)} }, stdio: 'inherit' });
  process.exit(child.status ?? 1);
}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  process.env.TMPDIR = downloads;
  return {
    root,
    bin,
    commit,
    downloads,
    control: (value: Control) => writeFile(controlPath, JSON.stringify(value)),
    calls: async () =>
      (await readFile(callsPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call),
    clean: async () => assert.deepEqual(await readdir(downloads), []),
  };
}

test('successful direct downloads never contact accelerators and dispose their clone', async (t) => {
  const f = await fixture(t);
  const snapshot = await downloadGitHubRepository(
    parseGitHubRepository('owner/repo'),
  );
  assert.equal(snapshot.commit, f.commit);
  const manifest = snapshot.files.find((file) =>
    file.path.endsWith('SKILL.md'),
  )!;
  assert.equal((await snapshot.read(manifest)).toString(), content);
  assert.deepEqual(
    (await f.calls()).filter((call) => call.remote).map((call) => call.remote),
    [source],
  );
  await snapshot.dispose();
  await f.clean();
});

test('failed direct and first-proxy clones fall back in order with fresh directories and unchanged source metadata', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [source, firstProxy] });
  const service = new SkillService(join(f.root, 'workspace'));
  const scan = await service.scan('owner/repo');
  assert.equal(scan.url, 'https://github.com/owner/repo');
  const calls = (await f.calls()).filter((call) => call.command === 'clone');
  assert.deepEqual(
    calls.map((call) => call.remote),
    [source, firstProxy, secondProxy],
  );
  assert.equal(new Set(calls.map((call) => call.args.at(-1))).size, 3);
  assert.equal((await readdir(f.downloads)).length, 1);
  await service.install(scan.id, ['catalog/example/SKILL.md']);
  assert.equal(
    await readFile(join(service.root, 'owner/repo/example/guide.txt'), 'utf8'),
    'Bundled resource',
  );
  const metadata = JSON.parse(
    await readFile(
      join(service.root, 'owner/repo/.skill-sources.json'),
      'utf8',
    ),
  );
  assert.equal(metadata.sources[0].url, 'https://github.com/owner/repo');
  await f.clean();
  await service.dispose();
});

test('scoped links retry ref discovery and clone through the same accelerator, including slash branches', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [source] });
  const snapshot = await downloadGitHubRepository(
    parseGitHubRepository(
      'https://github.com/owner/repo/tree/feature/skills/catalog',
    ),
  );
  assert.equal(snapshot.ref, 'feature/skills');
  assert.equal(snapshot.scopePath, 'catalog');
  const calls = (await f.calls()).filter((call) => call.remote);
  assert.deepEqual(
    calls.map((call) => [call.command, call.remote]),
    [
      ['ls-remote', source],
      ['ls-remote', firstProxy],
      ['clone', firstProxy],
    ],
  );
  const clone = calls.at(-1)!;
  assert.equal(
    clone.args[clone.args.indexOf('--branch') + 1],
    'feature/skills',
  );
  await snapshot.dispose();
  await f.clean();
});

test('a failure after ref discovery retries cloning without reusing partial files', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [source], failCommand: 'clone' });
  const snapshot = await downloadGitHubRepository(
    parseGitHubRepository(
      'https://github.com/owner/repo/blob/main/catalog/example/SKILL.md',
    ),
  );
  assert.equal(snapshot.fileOnly, true);
  assert.equal(snapshot.scopePath, 'catalog/example/SKILL.md');
  assert.deepEqual(
    (await f.calls())
      .filter((call) => call.remote)
      .map((call) => [call.command, call.remote]),
    [
      ['ls-remote', source],
      ['clone', source],
      ['ls-remote', firstProxy],
      ['clone', firstProxy],
    ],
  );
  assert.equal((await readdir(f.downloads)).length, 1);
  await snapshot.dispose();
  await f.clean();
});

test('saved commit and path use fetch fallback without resolving a different branch', async (t) => {
  const f = await fixture(t);
  await f.control({
    failedRemotes: [source, firstProxy],
    failCommand: 'fetch',
  });
  const snapshot = await downloadGitHubRepository(
    parseGitHubRepository('owner/repo'),
    undefined,
    { ref: f.commit, scope: 'catalog' },
  );
  assert.equal(snapshot.commit, f.commit);
  assert.equal(snapshot.ref, f.commit);
  assert.equal(snapshot.scopePath, 'catalog');
  const calls = (await f.calls()).filter((call) => call.remote);
  assert.deepEqual(
    calls.map((call) => [call.command, call.remote]),
    [
      ['fetch', source],
      ['fetch', firstProxy],
      ['fetch', secondProxy],
    ],
  );
  assert.ok(calls.every((call) => call.args.at(-1) === f.commit));
  await snapshot.dispose();
  await f.clean();
});

test('all failed sources return the download error and remove every temporary clone', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [source, firstProxy, secondProxy] });
  await assert.rejects(
    downloadGitHubRepository(parseGitHubRepository('owner/repo')),
    { code: 'SKILL_DOWNLOAD_FAILED' },
  );
  assert.deepEqual(
    (await f.calls()).filter((call) => call.remote).map((call) => call.remote),
    [source, firstProxy, secondProxy],
  );
  await f.clean();
});

test('cancelling an active clone cleans it and does not start a proxy request', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [source], hang: true });
  const controller = new AbortController();
  const result = assert.rejects(
    downloadGitHubRepository(
      parseGitHubRepository('owner/repo'),
      controller.signal,
    ),
    { code: 'SKILL_DOWNLOAD_FAILED' },
  );
  for (
    let attempt = 0;
    attempt < 100 && !(await f.calls()).some((call) => call.remote);
    attempt++
  )
    await delay(10);
  controller.abort();
  await result;
  assert.deepEqual(
    (await f.calls()).filter((call) => call.remote).map((call) => call.remote),
    [source],
  );
  await f.clean();
});

test('missing paths are not treated as connectivity failures', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    downloadGitHubRepository(
      parseGitHubRepository('https://github.com/owner/repo/tree/main/missing'),
    ),
    { code: 'SKILL_SOURCE_NOT_FOUND' },
  );
  assert.ok(
    (await f.calls())
      .filter((call) => call.remote)
      .every((call) => call.remote === source),
  );
  await f.clean();
});

test('unsafe repository content stops fallback and disposes the clone', async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(
    downloadGitHubRepository(parseGitHubRepository('owner/repo')),
    { code: 'SKILL_UNSAFE_REPOSITORY' },
  );
  assert.deepEqual(
    (await f.calls()).filter((call) => call.remote).map((call) => call.remote),
    [source],
  );
  await f.clean();
});

test('missing Git retains its specific error without any accelerator attempt', async (t) => {
  const f = await fixture(t);
  process.env.PATH = join(f.root, 'missing-bin');
  await assert.rejects(
    downloadGitHubRepository(parseGitHubRepository('owner/repo')),
    { code: 'SKILL_GIT_UNAVAILABLE' },
  );
  assert.deepEqual(await f.calls(), []);
  await f.clean();
});
