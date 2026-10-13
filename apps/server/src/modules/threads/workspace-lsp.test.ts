import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkspaceTools } from '@mastra/core/workspace';
import {
  createPersonalWorkspace,
  createProjectFilesystem,
  createProjectWorkspace,
  getWorkspace,
} from './workspace.js';

test(
  'workspace LSP exposes the native tool and inspects real TypeScript code',
  { timeout: 45000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'workspace-lsp-')),
    );
    const directory = await createPersonalWorkspace(root, 'alice');
    const workspace = getWorkspace(root, 'alice', directory);
    t.after(async () => {
      await workspace.destroy();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
    );
    await writeFile(
      join(directory, 'values.ts'),
      'export const count: number = 42;\n',
    );
    await writeFile(
      join(directory, 'main.ts'),
      'import { count } from "./values";\nconst label: string = count;\n',
    );
    await workspace.init();
    assert.ok(
      workspace.lsp,
      'protocol dependencies must be discoverable by Mastra',
    );
    const tools = await createWorkspaceTools(workspace);
    assert.ok(tools.lsp_inspect);
    assert.equal(tools.mastra_workspace_lsp_inspect, undefined);
    const result = await tools.lsp_inspect.execute(
      {
        path: join(directory, 'main.ts'),
        line: 2,
        match: 'const label: string = <<<count;',
      },
      {},
    );
    assert.equal(result.error, undefined);
    assert.match(result.hover?.value ?? '', /count/, JSON.stringify(result));
    assert.ok(
      result.definition?.some(
        (item: { location: string; preview: string | null }) =>
          /values\.ts:L1:C\d+$/.test(item.location) &&
          item.preview?.includes('count: number = 42'),
      ),
      JSON.stringify(result),
    );
    const typeInfo = await tools.lsp_inspect.execute(
      {
        path: 'values.ts',
        line: 1,
        match: 'export const <<<count: number = 42;',
      },
      {},
    );
    assert.equal(typeInfo.error, undefined);
    assert.match(typeInfo.hover?.value ?? '', /count.*number/s);
    assert.ok(
      result.diagnostics?.some(
        (item: { severity: string; message: string }) =>
          item.severity === 'error' && item.message.includes('not assignable'),
      ),
      JSON.stringify(result),
    );
    const invalid = await tools.lsp_inspect.execute(
      { path: 'main.ts', line: 2, match: 'count' },
      {},
    );
    assert.match(invalid.error, /No <<</);
    const duplicate = await tools.lsp_inspect.execute(
      { path: 'main.ts', line: 2, match: '<<<count<<<' },
      {},
    );
    assert.match(duplicate.error, /Multiple <<</);
    await writeFile(join(directory, 'notes.txt'), 'no language server\n');
    const unsupported = await tools.lsp_inspect.execute(
      { path: 'notes.txt', line: 1, match: '<<<no language server' },
      {},
    );
    assert.match(unsupported.error, /No language server available/);
    const processes = workspace.sandbox!.processes!;
    const running = (await processes.list()).filter(
      (process) => process.running,
    );
    assert.ok(running.length > 0, 'the language server starts on demand');
    const handles = await Promise.all(
      running.map((process) => processes.get(process.pid)),
    );
    await workspace.destroy();
    assert.equal(workspace.status, 'destroyed');
    assert.ok(
      handles.every((handle) => handle && handle.exitCode !== undefined),
    );
  },
);

test('LSP rejects other workspaces, traversal and escaping symlinks before querying', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'workspace-lsp-boundary-')),
  );
  const directory = await createPersonalWorkspace(root, 'alice');
  const otherDirectory = await createPersonalWorkspace(root, 'bob');
  const otherFile = join(otherDirectory, 'private.ts');
  await writeFile(otherFile, 'export const secret = 1;');
  await symlink(otherFile, join(directory, 'escape.ts'));
  const workspace = getWorkspace(root, 'alice', directory);
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const tools = await createWorkspaceTools(workspace);
  let queries = 0;
  workspace.lsp!.prepareQuery = async () => {
    queries++;
    return null;
  };
  for (const path of [
    otherFile,
    '../../bob/' + otherDirectory.split('/').at(-1) + '/private.ts',
    'escape.ts',
  ]) {
    const result = await tools.lsp_inspect.execute(
      { path, line: 1, match: 'export const <<<secret = 1;' },
      {},
    );
    assert.match(result.error, /inside the current workspace/);
  }
  const missing = await tools.lsp_inspect.execute(
    { path: 'missing.ts', line: 1, match: '<<<missing' },
    {},
  );
  assert.match(missing.error, /unavailable/);
  assert.equal(queries, 0);
});

test('LSP resolves composite mount paths to the sandbox project directory', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'workspace-lsp-mount-')),
  );
  const projectId = 'abcdefghijklmnop';
  const directory = await createProjectWorkspace(root, projectId);
  await mkdir(join(directory, 'src'));
  const file = join(directory, 'src', 'main.ts');
  await writeFile(file, 'export const count = 42;');
  const filesystem = createProjectFilesystem(directory, {
    mode: 'composite',
    mounts: [{ mountPath: 'src', provider: 'local' }],
  });
  const workspace = getWorkspace(
    root,
    'alice',
    directory,
    projectId,
    [],
    filesystem,
  );
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const queried: string[] = [];
  workspace.lsp!.prepareQuery = async (path) => {
    queried.push(path);
    return null;
  };
  const tools = await createWorkspaceTools(workspace);
  for (const path of ['/src/main.ts', 'src/main.ts', file]) {
    await tools.lsp_inspect.execute(
      { path, line: 1, match: 'export const <<<count = 42;' },
      {},
    );
  }
  assert.deepEqual(queried, [file, file, file]);
});
