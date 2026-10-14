import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlugins, generatePlugins } from './plugins.js';

async function fixture(
  plugins: {
    id: string;
    dependencies?: string[];
    pages?: unknown[];
    rightSidebar?: unknown[];
    apiVersion?: number;
  }[],
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-discovery-'));
  try {
    await mkdir(join(root, 'plugins'));
    for (const plugin of plugins) {
      const dir = join(root, 'plugins', plugin.id);
      await mkdir(join(dir, 'server'), { recursive: true });
      await mkdir(join(dir, 'web'));
      await writeFile(
        join(dir, 'plugin.manifest.json'),
        JSON.stringify({
          name: plugin.id,
          description: '',
          version: '1.0.0',
          apiVersion: 1,
          ...plugin,
        }),
      );
      for (const file of [
        'package.json',
        'server/index.ts',
        'server/database.ts',
        'web/index.tsx',
      ])
        await writeFile(join(dir, file), '{}');
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('discovery orders dependencies and emits deterministic browser/server entries', () =>
  fixture([{ id: 'a', dependencies: ['b'] }, { id: 'b' }], async (root) => {
    assert.deepEqual(
      (await discoverPlugins(root)).map((p) => p.manifest.id),
      ['b', 'a'],
    );
    await generatePlugins(root);
    const path = join(root, 'apps/web/src/features/plugins/generated.ts');
    const first = await readFile(path, 'utf8');
    assert.match(first, /\(\) => import\(/);
    assert.doesNotMatch(first, /server\//);
    await generatePlugins(root);
    assert.equal(await readFile(path, 'utf8'), first);
  }));
test('empty plugin set remains buildable', () =>
  fixture([], async (root) => {
    assert.equal(await generatePlugins(root), 0);
  }));
test('one plugin supports multiple pages including parameter routes and access scopes', () =>
  fixture(
    [
      {
        id: 'a',
        pages: [
          { path: '', title: 'Notes', navigation: true },
          { path: 'overview', title: 'Overview', navigation: true },
          { path: 'notes/:noteId', title: 'Note' },
          { path: 'overview', title: 'Administration', access: 'admin' },
        ],
      },
    ],
    async (root) => {
      const [plugin] = await discoverPlugins(root);
      assert.deepEqual(
        plugin.manifest.pages.map((page) => [page.path, page.access]),
        [
          ['', 'session'],
          ['overview', 'session'],
          ['notes/:noteId', 'session'],
          ['overview', 'admin'],
        ],
      );
      await generatePlugins(root);
      const source = await readFile(
        join(root, 'apps/web/src/features/plugins/generated.ts'),
        'utf8',
      );
      assert.match(source, /path: 'overview'/);
      assert.match(source, /path: 'notes\/:noteId'/);
    },
  ));
test('missing dependencies fail discovery', () =>
  fixture([{ id: 'a', dependencies: ['absent'] }], async (root) => {
    await assert.rejects(discoverPlugins(root), /Missing plugin dependency/);
  }));
test('cycles fail discovery', () =>
  fixture(
    [
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ],
    async (root) => {
      await assert.rejects(discoverPlugins(root), /Cyclic/);
    },
  ));
test('unsupported SDK versions fail discovery', () =>
  fixture([{ id: 'a', apiVersion: 2 }], async (root) => {
    await assert.rejects(discoverPlugins(root));
  }));
test('ambiguous page parameters fail discovery', () =>
  fixture(
    [
      {
        id: 'a',
        pages: [
          { path: 'notes/:id', title: 'Note' },
          { path: 'notes/:name', title: 'Note' },
        ],
      },
    ],
    async (root) => {
      await assert.rejects(discoverPlugins(root), /Duplicate plugin page/);
    },
  ));
test('parameterized navigation cannot create broken links', () =>
  fixture(
    [{ id: 'a', pages: [{ path: ':id', title: 'Note', navigation: true }] }],
    async (root) => {
      await assert.rejects(discoverPlugins(root), /Navigation pages/);
    },
  ));

test('one plugin can contribute multiple lazy sidebar entries, including admin-only entries', () =>
  fixture(
    [
      {
        id: 'a',
        rightSidebar: [
          { id: 'notes', title: 'Notes', icon: 'notebook' },
          { id: 'overview', title: 'Overview', access: 'admin', icon: 'chart' },
        ],
      },
      { id: 'b', rightSidebar: [{ id: 'notes', title: 'Other notes' }] },
    ],
    async (root) => {
      const plugins = await discoverPlugins(root);
      assert.deepEqual(
        plugins[0].manifest.rightSidebar.map((entry) => [
          entry.id,
          entry.access,
        ]),
        [
          ['notes', 'session'],
          ['overview', 'admin'],
        ],
      );
      await generatePlugins(root);
      const source = await readFile(
        join(root, 'apps/web/src/features/plugins/generated.ts'),
        'utf8',
      );
      assert.match(source, /rightSidebar:/);
      assert.match(source, /id: 'overview'/);
      assert.match(source, /\(\) => import\(/);
    },
  ));
test('sidebar IDs must be unique within the plugin, regardless of access', () =>
  fixture(
    [
      {
        id: 'a',
        rightSidebar: [
          { id: 'notes', title: 'Notes' },
          { id: 'notes', title: 'Admin notes', access: 'admin' },
        ],
      },
    ],
    async (root) => {
      await assert.rejects(discoverPlugins(root), /Duplicate plugin sidebar/);
    },
  ));
test('existing plugins default to no sidebar entries', () =>
  fixture([{ id: 'a' }], async (root) => {
    assert.deepEqual(
      (await discoverPlugins(root))[0].manifest.rightSidebar,
      [],
    );
  }));
test('sidebar identifiers and icon names are validated during discovery', () =>
  fixture(
    [
      {
        id: 'a',
        rightSidebar: [{ id: '../notes', title: 'Notes', icon: 'missing' }],
      },
    ],
    async (root) => {
      await assert.rejects(discoverPlugins(root));
    },
  ));
