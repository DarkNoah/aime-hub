import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { discoverPlugins, generatePlugins } from './plugins.js';

async function fixture(
  plugins: {
    id: string;
    enabled?: unknown;
    dependencies?: string[];
    pages?: unknown[];
    rightSidebar?: unknown[];
    apiVersion?: number;
  }[],
  run: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-discovery-'));
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
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
test('manifest enabled defaults to true without enabling the runtime', () =>
  fixture([{ id: 'a' }], async (root) => {
    assert.equal((await discoverPlugins(root))[0].manifest.enabled, true);
  }));
test('manifest enabled must be a boolean', () =>
  fixture([{ id: 'a', enabled: 'false' }], async (root) => {
    await assert.rejects(discoverPlugins(root));
  }));
test('disabled plugins skip entries and dependencies while selected plugins remain discoverable', () =>
  fixture(
    [
      { id: 'excluded', enabled: false, dependencies: ['absent'] },
      { id: 'selected' },
    ],
    async (root) => {
      await rm(join(root, 'plugins/excluded/server'), { recursive: true });
      await rm(join(root, 'plugins/excluded/web'), { recursive: true });
      assert.deepEqual(
        (await discoverPlugins(root)).map((plugin) => plugin.manifest.id),
        ['selected'],
      );
      await generatePlugins(root);
      const css = await readFile(
        join(root, 'apps/web/src/features/plugins/generated.css'),
        'utf8',
      );
      assert.match(css, /plugins\/selected\/web/);
      assert.doesNotMatch(css, /excluded/);
    },
  ));
test('a selected plugin cannot implicitly load a disabled dependency', () =>
  fixture(
    [
      { id: 'a', dependencies: ['b'] },
      { id: 'b', enabled: false },
    ],
    async (root) => {
      await assert.rejects(
        discoverPlugins(root),
        /Disabled plugin dependency: b/,
      );
    },
  ));
test('disabling removes generated code, styles and skills without importing excluded entrypoints', () =>
  fixture([{ id: 'excluded' }], async (root) => {
    const pluginDir = join(root, 'plugins/excluded');
    await mkdir(join(pluginDir, 'skills/guide'), { recursive: true });
    await writeFile(join(pluginDir, 'skills/guide/SKILL.md'), '# Guide');
    assert.equal(await generatePlugins(root), 1);
    const serverDir = join(root, 'apps/server/src/modules/plugins');
    assert.deepEqual(await readdir(join(serverDir, 'bundled-skills')), [
      'excluded',
    ]);
    const manifestPath = join(pluginDir, 'plugin.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, enabled: false }),
    );
    for (const entry of [
      'server/index.ts',
      'server/database.ts',
      'web/index.tsx',
    ])
      await writeFile(
        join(pluginDir, entry),
        "throw new Error('Excluded plugin must never execute');",
      );
    assert.equal(await generatePlugins(root), 0);
    for (const file of [
      'apps/server/src/modules/plugins/generated.ts',
      'apps/server/src/modules/plugins/generated-database.ts',
      'apps/web/src/features/plugins/generated.ts',
      'apps/web/src/features/plugins/generated.css',
    ])
      assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /excluded/);
    assert.deepEqual(await readdir(join(serverDir, 'bundled-skills')), []);
    const server = await import(
      pathToFileURL(join(serverDir, 'generated.ts')).href
    );
    const database = await import(
      pathToFileURL(join(serverDir, 'generated-database.ts')).href
    );
    const web = await import(
      pathToFileURL(join(root, 'apps/web/src/features/plugins/generated.ts'))
        .href
    );
    assert.deepEqual(server.installedPlugins, []);
    assert.deepEqual(database.pluginDatabases, []);
    assert.deepEqual(web.pluginManifests, []);
    assert.deepEqual(web.pluginLoaders, {});
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
