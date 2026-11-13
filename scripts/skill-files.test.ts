import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth } from '@aime/auth';
import { FILE_TEXT_LIMIT } from '@aime/shared/files';
import { createApp } from '../apps/server/src/app.js';
import { SkillService } from '../apps/server/src/modules/skills/service.js';

const origin = 'http://localhost:5173';
const skill = 'owner/repo/research';
const manifest = (description: string) =>
  `---\nname: research\ndescription: ${description}\n---\n# Research\n`;

async function fixture(t: test.TestContext) {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), 'skill-files-')),
  );
  const service = new SkillService(workspace);
  t.after(async () => {
    await service.dispose();
    await rm(workspace, { recursive: true, force: true });
  });
  const root = join(service.forUser('alice').root, skill);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'SKILL.md'), manifest('Original'));
  await writeFile(join(root, 'scripts/run.sh'), '#!/bin/sh\necho original\n', {
    mode: 0o755,
  });
  await writeFile(
    join(root, 'asset.png'),
    Buffer.from([137, 80, 78, 71, 0, 1]),
  );
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 255, 1]));
  await mkdir(join(service.root, skill), { recursive: true });
  await writeFile(join(service.root, skill, 'SKILL.md'), manifest('Global'));
  const auth = {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const id = headers.get('x-test-user');
        return id
          ? {
              user: { id, role: id === 'admin' ? 'admin' : 'user' },
              session: { id },
            }
          : null;
      },
    },
  } as unknown as Auth;
  const app = createApp(auth, undefined, undefined, {
    service,
    webOrigin: origin,
  });
  const request = (route: string, options: RequestInit = {}) =>
    app.request(route, {
      ...options,
      headers: {
        'x-test-user': 'alice',
        origin,
        'content-type': 'application/json',
        ...options.headers,
      },
    });
  const url = (route = '', path = '', selectedSkill = skill) =>
    `/api/skills/files${route}?${new URLSearchParams({ skill: selectedSkill, path })}`;
  const preview = async (path: string) => {
    const response = await request(url('/preview', path));
    assert.equal(response.status, 200);
    return response.json();
  };
  const save = (
    path: string,
    text: string,
    version: string,
    options: RequestInit = {},
  ) =>
    request(url('/content'), {
      method: 'PUT',
      body: JSON.stringify({ path, text, version }),
      ...options,
    });
  return { workspace, root, service, request, url, preview, save };
}

test('skill files browse nested packages, save manifests and scripts, and return only the edited skill metadata', async (t) => {
  const { root, request, url, preview, save } = await fixture(t);
  const list = await request(url());
  assert.equal(list.status, 200);
  assert.deepEqual(
    (await list.json()).entries.map((entry: { path: string }) => entry.path),
    ['scripts', 'asset.png', 'binary.dat', 'SKILL.md'],
  );
  assert.equal(
    (await (await request(url('', 'scripts'))).json()).entries[0].path,
    'scripts/run.sh',
  );
  const before = await preview('SKILL.md');
  const saved = await save(
    'SKILL.md',
    manifest('Edited description'),
    before.version,
  );
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.skill.description, 'Edited description');
  assert.equal(result.skill.path, skill);
  assert.notEqual(result.file.version, before.version);
  assert.equal(
    await readFile(join(root, 'SKILL.md'), 'utf8'),
    manifest('Edited description'),
  );
  const script = await preview('scripts/run.sh');
  assert.equal(
    (await save(script.path, '#!/bin/sh\necho edited\n', script.version))
      .status,
    200,
  );
  assert.equal((await stat(join(root, script.path))).mode & 0o777, 0o755);
  const invalid = await save(
    'SKILL.md',
    'Temporarily invalid manifest',
    result.file.version,
  );
  assert.equal(invalid.status, 200);
  assert.equal((await invalid.json()).skill.valid, false);
  assert.equal(
    (await preview('SKILL.md')).text,
    'Temporarily invalid manifest',
  );
});

test('skill file saves reject stale versions, binary data and oversized text without losing content', async (t) => {
  const { root, preview, save } = await fixture(t);
  const before = await preview('SKILL.md');
  const saves = await Promise.all([
    save('SKILL.md', manifest('First'), before.version),
    save('SKILL.md', manifest('Second'), before.version),
  ]);
  assert.deepEqual(saves.map((response) => response.status).sort(), [200, 409]);
  const conflict = saves.find((response) => response.status === 409)!;
  assert.equal((await conflict.json()).code, 'FILE_CHANGED');
  const current = await preview('SKILL.md');
  assert.equal((await save('SKILL.md', '\0', current.version)).status, 400);
  assert.equal(
    (await save('SKILL.md', '中'.repeat(FILE_TEXT_LIMIT / 2), current.version))
      .status,
    413,
  );
  assert.equal(
    (await save('binary.dat', 'replacement', 'version')).status,
    400,
  );
  assert.equal(await readFile(join(root, 'SKILL.md'), 'utf8'), current.text);
});

test('skill files reject traversal, symlinks and non-package roots across list, preview, save and raw', async (t) => {
  const { workspace, root, service, request, url, save } = await fixture(t);
  await writeFile(join(workspace, 'secret.txt'), 'outside');
  await symlink(join(workspace, 'secret.txt'), join(root, 'external'));
  await symlink(workspace, join(root, 'linked-directory'));
  for (const path of [
    '../SKILL.md',
    '/etc/passwd',
    'scripts/../../SKILL.md',
    'scripts\\run.sh',
  ]) {
    for (const route of ['', '/preview', '/raw'])
      assert.equal(
        (await request(url(route, path))).status,
        400,
        `${route} ${path}`,
      );
    assert.equal((await save(path, 'changed', 'version')).status, 400);
  }
  for (const path of ['external', 'linked-directory/secret.txt']) {
    assert.equal((await request(url('/preview', path))).status, 403);
    assert.equal((await request(url('/raw', path))).status, 403);
    assert.equal((await save(path, 'changed', 'version')).status, 403);
  }
  assert.equal((await request(url('', 'linked-directory'))).status, 403);
  assert.equal((await request(url('', '', 'owner/repo'))).status, 404);
  assert.equal((await request(url('', '', '../elsewhere'))).status, 403);
  assert.equal((await request(url('/preview', 'missing'))).status, 404);
  const entries = (await (await request(url())).json()).entries;
  assert.ok(
    !entries.some(
      (entry: { name: string }) =>
        entry.name === 'external' || entry.name === 'linked-directory',
    ),
  );
  assert.equal(
    await readFile(join(workspace, 'secret.txt'), 'utf8'),
    'outside',
  );
  const linked = join(service.forUser('alice').root, 'linked-package');
  await symlink(root, linked);
  assert.equal((await request(url('', '', 'linked-package'))).status, 403);
});

test('skill file HTTP/RPC endpoints enforce user/admin ownership and origin, including binary previews', async (t) => {
  const { request, url, preview, save } = await fixture(t);
  for (const route of ['', '/preview', '/raw']) {
    assert.equal(
      (
        await request(url(route, route ? 'SKILL.md' : ''), {
          headers: { 'x-test-user': '' },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(url(route, route ? 'SKILL.md' : ''), {
          headers: { 'x-test-user': 'bob' },
        })
      ).status,
      404,
    );
    const global = url(route, route ? 'SKILL.md' : '').replace(
      '/api/skills',
      '/api/admin/skills',
    );
    assert.equal((await request(global)).status, 403);
    assert.equal(
      (await request(global, { headers: { 'x-test-user': 'admin' } })).status,
      200,
    );
  }
  const before = await preview('SKILL.md');
  assert.equal(
    (
      await save('SKILL.md', 'changed', before.version, {
        headers: { origin: 'https://elsewhere.test' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await save('SKILL.md', 'changed', before.version, {
        headers: { 'x-test-user': 'bob' },
      })
    ).status,
    404,
  );
  const input = {
    json: {
      query: { skill },
      body: {
        path: 'SKILL.md',
        text: manifest('RPC saved'),
        version: before.version,
      },
    },
  };
  assert.equal(
    (
      await request('/api/rpc/personalSkills/files/save', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { origin: 'https://elsewhere.test' },
      })
    ).status,
    403,
  );
  const rpc = await request('/api/rpc/personalSkills/files/save', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  assert.equal(rpc.status, 200);
  assert.equal((await rpc.json()).json.skill.description, 'RPC saved');
  const raw = await request(url('/raw', 'asset.png'));
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'image/png');
  assert.equal(raw.headers.get('cache-control'), 'no-store');
  assert.match(raw.headers.get('content-security-policy')!, /sandbox/);
  assert.deepEqual(
    Buffer.from(await raw.arrayBuffer()),
    Buffer.from([137, 80, 78, 71, 0, 1]),
  );
  const download = await request(`${url('/raw', 'scripts/run.sh')}&download=1`);
  assert.match(download.headers.get('content-disposition')!, /attachment/);
});
