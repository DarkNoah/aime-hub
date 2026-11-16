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
const proxyKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];
const observedEnvKeys = [
  ...proxyKeys,
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_COUNT',
  'GIT_DIR',
  'SKILL_TEST_SECRET',
];
type Call = {
  command: string;
  remote?: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};
type Control = {
  failedRemotes?: string[];
  failCommand?: string;
  hang?: boolean;
};

// Exercise real Git clones and object reads against a local repository, while controlling only the transport.
async function fixture(
  t: test.TestContext,
  unsafe = false,
  environment: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'github-skill-transport-'));
  const repo = join(root, 'upstream');
  const bin = join(root, 'bin');
  const downloads = join(root, 'downloads');
  const controlPath = join(root, 'control.json');
  const callsPath = join(root, 'calls.jsonl');
  const originalPath = process.env.PATH;
  const originalTmp = process.env.TMPDIR;
  const originalEnv = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  t.after(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
const env = Object.fromEntries(${JSON.stringify(observedEnvKeys)}.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command, remote, args, cwd: process.cwd(), env }) + '\n');
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
  Object.assign(process.env, environment);
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

test('downloads forward process proxy variables including empty values without inheriting Git configuration or secrets', async (t) => {
  const proxies = Object.fromEntries(
    proxyKeys.map((key, index) => [
      key,
      key.toLowerCase() === 'no_proxy'
        ? 'localhost,.internal'
        : index === 5
          ? ''
          : `http://proxy-${index}.test:8080`,
    ]),
  );
  const f = await fixture(t, false, {
    ...proxies,
    GIT_CONFIG_GLOBAL: '/invalid/git-config',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '!false',
    GIT_DIR: '/invalid/repository',
    SKILL_TEST_SECRET: 'must-not-reach-git',
  });
  const snapshot = await downloadGitHubRepository(
    parseGitHubRepository('owner/repo'),
  );
  await snapshot.dispose();
  const calls = await f.calls();
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.deepEqual(call.env, { ...proxies, GIT_CONFIG_GLOBAL: '/dev/null' });
  }
  await f.clean();
});

test('scoped proxy overrides reach ref discovery, clone and every mirror attempt', async (t) => {
  const f = await fixture(t);
  await f.control({ failedRemotes: [source, firstProxy] });
  const environment = {
    HTTPS_PROXY: 'http://scoped-proxy.test:8080',
    https_proxy: '',
    NO_PROXY: 'localhost,.internal',
    GIT_DIR: '/invalid/repository',
    SKILL_TEST_SECRET: 'must-not-reach-git',
  };
  const snapshot = await downloadGitHubRepository(
    parseGitHubRepository('https://github.com/owner/repo/tree/main/catalog'),
    undefined,
    undefined,
    environment,
  );
  await snapshot.dispose();
  const calls = (await f.calls()).filter((call) => call.remote);
  assert.deepEqual(
    calls.map((call) => [call.command, call.remote]),
    [
      ['ls-remote', source],
      ['ls-remote', firstProxy],
      ['ls-remote', secondProxy],
      ['clone', secondProxy],
    ],
  );
  for (const call of calls) {
    assert.deepEqual(call.env, {
      HTTPS_PROXY: environment.HTTPS_PROXY,
      https_proxy: '',
      NO_PROXY: environment.NO_PROXY,
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
  }
  await f.clean();
});

test('management downloads refresh scoped settings for global and personal imports and updates', async (t) => {
  const f = await fixture(t, false, {
    https_proxy: 'http://host-proxy.test:8080',
  });
  let globalProxy: string | undefined = 'http://global-proxy.test:8080';
  const personal = new Map([
    ['alice', 'http://alice-proxy.test:8080'],
    ['bob', ''],
  ]);
  const scopes: (string | undefined)[] = [];
  const service = new SkillService(
    join(f.root, 'workspace'),
    undefined,
    undefined,
    {
      async getEnv(userId) {
        scopes.push(userId);
        const value =
          userId !== undefined && personal.has(userId)
            ? personal.get(userId)
            : globalProxy;
        return {
          ...(value !== undefined ? { https_proxy: value } : {}),
          PATH: '/invalid/bin',
          GIT_DIR: '/invalid/repository',
          SKILL_TEST_SECRET: 'must-not-reach-git',
        };
      },
    },
  );
  t.after(() => service.dispose());
  const alice = service.forUser('alice');
  const bob = service.forUser('bob');
  const scans = await Promise.all([
    service.scan('owner/repo'),
    alice.scan('owner/repo'),
    bob.scan('owner/repo'),
  ]);
  await service.discard(scans[0].id);
  await alice.install(scans[1].id, ['catalog/example/SKILL.md']);
  await bob.discard(scans[2].id);
  assert.deepEqual(scopes, [undefined, 'alice', 'bob']);
  const initialProxies = (await f.calls())
    .filter((call) => call.remote)
    .map((call) => call.env.https_proxy)
    .sort();
  assert.deepEqual(initialProxies, [
    '',
    'http://alice-proxy.test:8080',
    'http://global-proxy.test:8080',
  ]);

  // Cached personal services must still read fresh settings on each update.
  personal.delete('alice');
  globalProxy = 'http://updated-global.test:8080';
  await alice.updateGroup('owner/repo');
  assert.equal(
    (await f.calls()).filter((call) => call.remote).at(-1)?.env.https_proxy,
    globalProxy,
  );
  globalProxy = undefined;
  await alice.updateGroup('owner/repo');
  const calls = (await f.calls()).filter((call) => call.remote);
  assert.equal(calls.at(-1)?.env.https_proxy, 'http://host-proxy.test:8080');
  assert.deepEqual(scopes, [undefined, 'alice', 'bob', 'alice', 'alice']);
  for (const call of calls) {
    assert.equal(call.env.GIT_DIR, undefined);
    assert.equal(call.env.SKILL_TEST_SECRET, undefined);
  }
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
    { ALL_PROXY: 'socks5h://scoped-proxy.test:1080', no_proxy: '' },
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
  assert.ok(
    calls.every(
      (call) =>
        call.env.ALL_PROXY === 'socks5h://scoped-proxy.test:1080' &&
        call.env.no_proxy === '',
    ),
  );
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
    // Allow slow process startup; the assertion below still requires an active clone.
    attempt < 500 && !(await f.calls()).some((call) => call.remote);
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
