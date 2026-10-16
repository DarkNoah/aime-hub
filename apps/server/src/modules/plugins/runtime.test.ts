import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginRuntime } from './runtime.js';

test('plugin runtime uses host paths and lazily creates isolated persistent workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-runtime-'));
  try {
    const options = {
      applicationRoot: join(root, 'app'),
      workspaceRoot: join(root, 'configured-space'),
    };
    const runtime = createPluginRuntime(
      { id: 'one', workspace: true },
      options,
    );
    assert.equal(runtime.paths.pluginRoot, join(root, 'app/plugins/one'));
    assert.equal(runtime.paths.workspaceRoot, options.workspaceRoot);
    assert.equal(runtime.platform, process.platform);
    assert.ok(Object.isFrozen(runtime.paths));
    await assert.rejects(access(options.workspaceRoot));
    const directory = await runtime.ensureWorkspace();
    assert.equal(directory, join(options.workspaceRoot, 'plugins/one'));
    await writeFile(join(directory, 'keep'), 'persistent');
    await runtime.ensureWorkspace();
    assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'persistent');
    const other = createPluginRuntime({ id: 'two', workspace: true }, options);
    assert.notEqual(await other.ensureWorkspace(), directory);
    await assert.rejects(
      createPluginRuntime({ id: 'off' }, options).ensureWorkspace(),
      /declare workspace/,
    );
    assert.throws(() =>
      createPluginRuntime({ id: '../escape', workspace: true }, options),
    );
    await mkdir(join(root, 'outside'));
    await symlink(
      join(root, 'outside'),
      join(options.workspaceRoot, 'plugins/escape'),
      'dir',
    );
    await assert.rejects(
      createPluginRuntime(
        { id: 'escape', workspace: true },
        options,
      ).ensureWorkspace(),
      /inside the configured workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
