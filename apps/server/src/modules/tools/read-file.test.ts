import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  symlink,
  truncate,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Workspace,
  LocalFilesystem,
  CompositeFilesystem,
  createWorkspaceTools,
  readFileTool,
} from '@mastra/core/workspace';
import { AgentFSFilesystem } from '@mastra/agentfs';
import type { DataSource } from 'typeorm';
import { defaultReadFileConfig } from '@aime/shared/tools';
import { emptyModelDefaults } from '@aime/shared/providers';
import { createReadFileTool } from '../../mastra/tools/read_file.js';
import type { OcrOptions } from '../../mastra/providers/ocr-model.js';
import { PaddleOCRProvider } from '../../mastra/providers/paddleocr.js';
import { MinerUProvider } from '../../mastra/providers/mineru.js';
import { maxBinaryFileBytes } from '../files/binary-file.js';
import { ToolService, buildTools } from './service.js';
import { createExecTool } from '../../mastra/tools/exec.js';
import { isValidationError, noopObserve } from '@mastra/core/tools';
import { parseViewFileOutput } from '../../../../web/src/components/chat/message-preview/view-file-output.js';
import { createPersonalWorkspace, getWorkspace } from '../threads/workspace.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j01sAAAAASUVORK5CYII=',
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\n%%EOF');
const config = { ...defaultReadFileConfig, model: 'ocr/PaddleOCR-VL' };
function fixture(markdown = '# Parsed 12345') {
  const calls: OcrOptions[] = [];
  const tool = createReadFileTool(config, {
    resolveModel: async (reference) => ({
      reference: reference!,
      model: {
        provider: 'paddleocr',
        modelId: 'PaddleOCR-VL',
        doOCR: async (options) => {
          calls.push(options);
          return { markdown, taskId: 'task-id' };
        },
      },
    }),
  });
  return { calls, tool, execute: runnable(tool) };
}
function runnable(tool: ReturnType<typeof createReadFileTool>) {
  type Execute = NonNullable<typeof tool.execute>;
  return async (
    input: Omit<Parameters<Execute>[0], 'showLineNumbers'> & {
      showLineNumbers?: boolean;
    },
    context: Partial<Parameters<Execute>[1]> = {},
  ) => {
    const result = await tool.execute!(
      { showLineNumbers: true, ...input },
      {
        observe: noopObserve,
        ...context,
      },
    );
    assert.ok(result && typeof result === 'object' && 'ok' in result);
    return result;
  };
}
async function workspace(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'view-file-')));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  await writeFile(join(directory, 'image.png'), png);
  await writeFile(join(directory, 'document.pdf'), pdf);
  await mkdir(join(directory, '.uploads'));
  await writeFile(join(directory, '.uploads/photo.png'), png);
  t.after(async () => {
    await workspace.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  return { workspace, directory };
}

test('read_file reads images, absolute workspace paths and uploaded paths, returning text and source metadata', async (t) => {
  const w = await workspace(t);
  const f = fixture();
  for (const path of [
    'image.png',
    join(w.directory, 'image.png'),
    '/.uploads/photo.png',
  ]) {
    const result = await f.execute({ path }, w);
    assert.equal(result.ok, true);
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.width, 1);
    assert.equal(result.size, png.length);
    assert.equal(result.model, config.model);
    assert.deepEqual(result.content, [
      { type: 'text', text: '# Parsed 12345' },
    ]);
    assert.equal(result.truncated, false);
    const ui = parseViewFileOutput(JSON.stringify(result));
    assert.equal(ui?.text, '# Parsed 12345');
    assert.equal(ui?.isError, false);
    assert.doesNotMatch(JSON.stringify(result), /base64/);
  }
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[0].input.data, png);
});

test('wrapped Mastra read_file preserves text ranges, encoding and native media output without OCR configuration', async (t) => {
  const w = await workspace(t);
  await writeFile(join(w.directory, 'notes.txt'), 'first\nsecond\nthird\n');
  await writeFile(join(w.directory, '.uploads/notes.txt'), 'uploaded text');
  const tool = createReadFileTool();
  const context = { workspace: w.workspace, observe: noopObserve };
  for (const options of [
    { path: 'notes.txt', showLineNumbers: true },
    { path: 'notes.txt', offset: 2, limit: 1, showLineNumbers: false },
    { path: 'notes.txt', encoding: 'base64' as const, showLineNumbers: false },
    { path: 'image.png', encoding: 'base64' as const, showLineNumbers: false },
  ]) {
    const result = await tool.execute!(options, context);
    const native = await readFileTool.execute!(options, context);
    assert.deepEqual(result, native);
    assert.ok(result && !isValidationError(result));
    assert.ok(native && !isValidationError(native));
    assert.deepEqual(
      await tool.toModelOutput!(result),
      await readFileTool.toModelOutput!(native),
    );
  }
  assert.match(
    String(
      await tool.execute!(
        { path: '/.uploads/notes.txt', showLineNumbers: false },
        context,
      ),
    ),
    /uploaded text/,
  );
  await writeFile(join(w.directory, 'empty.txt'), '');
  assert.equal(
    typeof (await tool.execute!(
      { path: 'empty.txt', showLineNumbers: true },
      context,
    )),
    'string',
  );
});

test('exec exposes only the wrapped read_file and uses it for text and OCR calls', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'exec-read-file-')));
  const directory = await createPersonalWorkspace(root, 'alice');
  const workspace = getWorkspace(root, 'alice', directory);
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'notes.txt'), 'first\nsecond\nthird');
  await writeFile(join(directory, 'image.png'), png);
  const f = fixture();
  const exec = createExecTool({
    getTools: async () => ({ read_file: f.tool }),
  });
  const result = await exec.execute!(
    {
      code: `text(ALL_TOOLS.filter(t => ['read', 'read_file', 'view_file', 'mastra_workspace_read_file'].includes(t.name)).map(t => t.name));
text(await tools.read_file({ path: 'notes.txt', offset: 2, limit: 1, showLineNumbers: false }));
text(await tools.read_file({ path: 'image.png' }));
const fs = await import('node:fs/promises'); text(await fs.readFile('notes.txt', 'utf8'));`,
      yield_time_ms: 3000,
      max_output_tokens: 2000,
    },
    { workspace, observe: noopObserve },
  );
  assert.ok(result && !isValidationError(result));
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const text = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  assert.match(text, /\["read_file"\]/);
  assert.match(text, /lines 2-2[\s\S]*second/);
  assert.match(text, /# Parsed 12345/);
  assert.match(text, /first\nsecond\nthird/);
  assert.equal(f.calls.length, 1);
  const disabled = createExecTool({ getTools: async () => ({}) });
  const denied = await disabled.execute!(
    {
      code: `const fs = await import('node:fs/promises'); text(await fs.readFile('notes.txt', 'utf8'));`,
      yield_time_ms: 3000,
      max_output_tokens: 1000,
    },
    { workspace, observe: noopObserve },
  );
  assert.ok(denied && !isValidationError(denied));
  assert.equal(denied.isError, true);
});

test('PDF page ranges are forwarded, but rejected for images and unsupported endpoints', async (t) => {
  const w = await workspace(t);
  const f = fixture();
  const result = await f.execute(
    { path: 'document.pdf', page_ranges: '1-3,5' },
    w,
  );
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'pdf');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(f.calls[0].pageRanges, '1-3,5');
  assert.equal(
    (await f.execute({ path: 'image.png', page_ranges: '1' }, w)).code,
    'INVALID_PAGE_RANGES',
  );
  const model = new PaddleOCRProvider({
    id: 'ocr',
    baseUrl: 'https://ocr.example/layout-parsing',
  }).ocrModel('PaddleOCR-VL');
  const execute = runnable(
    createReadFileTool(config, {
      resolveModel: async () => ({ reference: config.model, model }),
    }),
  );
  assert.equal(
    (await execute({ path: 'document.pdf', page_ranges: '1' }, w)).code,
    'PAGE_RANGES_UNSUPPORTED',
  );
});

test('workspace boundaries, escaping symlinks, invalid content and unsupported formats fail before contacting OCR', async (t) => {
  const w = await workspace(t);
  const f = fixture();
  await symlink('/etc/passwd', join(w.directory, 'linked.png'));
  await writeFile(join(w.directory, 'invalid.png'), 'plain text');
  await writeFile(join(w.directory, 'empty.pdf'), '');
  await writeFile(join(w.directory, 'invalid.pdf'), png);
  await writeFile(join(w.directory, 'large.pdf'), pdf);
  await truncate(join(w.directory, 'large.pdf'), maxBinaryFileBytes + 1);
  const cases = [
    ['../outside.png', 'FILE_FORBIDDEN'],
    ['/etc/passwd', 'FILE_FORBIDDEN'],
    ['linked.png', 'FILE_FORBIDDEN'],
    ['missing.png', 'ENOENT'],
    ['invalid.png', 'FILE_INVALID_FORMAT'],
    ['invalid.pdf', 'FILE_INVALID_FORMAT'],
    ['empty.pdf', 'FILE_EMPTY'],
    ['large.pdf', 'FILE_TOO_LARGE'],
    ['.uploads', 'FILE_NOT_FILE'],
    ['image\u0000.png', 'FILE_INVALID_PATH'],
  ];
  for (const [path, code] of cases) {
    const result = await f.execute({ path }, w);
    assert.equal(result.ok, false, path);
    assert.equal(result.code, code, path);
    assert.equal(parseViewFileOutput(result)?.isError, true);
  }
  assert.equal(f.calls.length, 0);
});

test('unified read_file uses personal workspace permissions and replaces native reading tools', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'read-permissions-')),
  );
  const directory = await createPersonalWorkspace(root, 'alice');
  const sibling = await createPersonalWorkspace(root, 'alice');
  const other = await createPersonalWorkspace(root, 'bob');
  const workspace = getWorkspace(root, 'alice', directory);
  t.after(async () => {
    await workspace.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const shared = join(root, 'users/alice/shared/image.png');
  for (const path of [
    shared,
    join(sibling, 'image.png'),
    join(other, 'image.png'),
  ])
    await writeFile(path, png);
  await symlink(shared, join(directory, 'linked.png'));
  await symlink(join(other, 'image.png'), join(directory, 'escape.png'));
  await workspace.init();
  const tools = await createWorkspaceTools(workspace);
  assert.equal(tools.read, undefined);
  assert.equal(tools.read_file, undefined);
  const appTools = await buildTools(['read_file']);
  assert.ok(appTools.read_file);
  assert.equal(appTools.view_file, undefined);
  const f = fixture();
  for (const path of [
    '../shared/image.png',
    shared,
    join(sibling, 'image.png'),
    'linked.png',
  ]) {
    await readFileTool.execute!(
      { path, showLineNumbers: true },
      {
        workspace,
        observe: noopObserve,
      },
    );
    const result = await f.execute({ path }, { workspace });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.calls.at(-1)?.input.data, png);
  }
  const allowedCalls = f.calls.length;
  for (const path of [
    join(other, 'image.png'),
    '../../bob/' + other.split('/').at(-1) + '/image.png',
    'escape.png',
  ]) {
    const result = await f.execute({ path }, { workspace });
    assert.equal(result.code, 'FILE_FORBIDDEN', JSON.stringify(result));
  }
  assert.equal(f.calls.length, allowedCalls);
});

test('read_file honors provider allowedPaths changes and contained:false just like native reads', async (t) => {
  const w = await workspace(t);
  const directory = join(w.directory, 'limited');
  await mkdir(directory);
  const filesystem = new LocalFilesystem({
    basePath: directory,
    contained: true,
  });
  const limited = new Workspace({ filesystem });
  await limited.init();
  t.after(() => limited.destroy());
  const f = fixture();
  const path = '../image.png';
  await assert.rejects(filesystem.readFile(path), { code: 'EACCES' });
  assert.equal(
    (await f.execute({ path }, { workspace: limited })).code,
    'FILE_FORBIDDEN',
  );
  filesystem.setAllowedPaths([w.directory]);
  assert.deepEqual(await filesystem.readFile(path), png);
  assert.equal((await f.execute({ path }, { workspace: limited })).ok, true);
  filesystem.setAllowedPaths([]);
  assert.equal(
    (await f.execute({ path }, { workspace: limited })).code,
    'FILE_FORBIDDEN',
  );
  const unrestricted = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory, contained: false }),
  });
  await unrestricted.init();
  t.after(() => unrestricted.destroy());
  assert.deepEqual(await unrestricted.filesystem!.readFile(path), png);
  assert.equal(
    (await f.execute({ path }, { workspace: unrestricted })).ok,
    true,
  );
});

test('read_file reads both local and AgentFS mounts in project workspaces', async (t) => {
  const w = await workspace(t);
  const virtual = new AgentFSFilesystem({
    path: join(w.directory, 'virtual.db'),
  });
  const filesystem = new CompositeFilesystem({
    mounts: {
      '/local': new LocalFilesystem({ basePath: w.directory }),
      '/virtual': virtual,
    },
  });
  const composite = new Workspace({ filesystem });
  await composite.init();
  try {
    await filesystem.writeFile('/virtual/image.png', png);
    const f = fixture();
    for (const path of ['/local/image.png', '/virtual/image.png']) {
      const result = await f.execute({ path }, { workspace: composite });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.file_path, path.slice(1));
      assert.deepEqual(f.calls.at(-1)?.input.data, png);
    }
  } finally {
    await composite.destroy();
  }
});

test('missing configuration, cancellation, timeouts and upstream failures produce safe errors', async (t) => {
  const w = await workspace(t);
  const unconfigured = runnable(createReadFileTool());
  assert.equal(
    (await unconfigured({ path: 'image.png' })).code,
    'WORKSPACE_UNAVAILABLE',
  );
  assert.equal(
    (await unconfigured({ path: 'image.png' }, w)).code,
    'OCR_NOT_CONFIGURED',
  );
  const f = fixture();
  assert.equal(
    (
      await f.execute(
        { path: 'image.png' },
        { ...w, abortSignal: AbortSignal.abort() },
      )
    ).code,
    'CANCELLED',
  );
  assert.equal(f.calls.length, 0);
  for (const timeout of [false, true]) {
    const tool = createReadFileTool(
      { ...config, timeoutMs: 15 },
      {
        resolveModel: async () => ({
          reference: config.model,
          model: {
            provider: 'paddleocr',
            modelId: 'PaddleOCR-VL',
            doOCR: async ({ abortSignal }) => {
              if (timeout)
                await new Promise((resolve) => setTimeout(resolve, 30));
              abortSignal?.throwIfAborted();
              throw new Error('credential=synthetic-secret');
            },
          },
        }),
      },
    );
    const result = await runnable(tool)({ path: 'image.png' }, w);
    assert.equal(result.code, timeout ? 'CANCELLED' : 'OCR_FAILED');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
  }
});

test('long OCR output is bounded consistently for the model and result preview', async (t) => {
  const w = await workspace(t);
  const f = fixture('a'.repeat(100001));
  const result = await f.execute({ path: 'image.png' }, w);
  assert.equal(result.truncated, true);
  assert.equal(result.content[0].text.length, 100000);
  assert.equal(parseViewFileOutput(result)?.truncated, true);
  const modelOutput = await f.tool.toModelOutput!(result);
  assert.ok(
    modelOutput && typeof modelOutput === 'object' && 'type' in modelOutput,
  );
  assert.equal(modelOutput.type, 'text');
  assert.match(JSON.stringify(modelOutput), /Output truncated/);
  assert.equal(
    parseViewFileOutput({ ok: true, file_path: 'a', content: 'wrong' }),
    null,
  );
});

test('saved OCR settings select MinerU or PaddleOCR and override caller defaults; disabled/incorrect models are rejected', async () => {
  const rows = new Map<string, { id: string; value: unknown }>();
  const database = {
    getRepository: () => ({
      findOneBy: async ({ id }: { id: string }) => rows.get(id),
      upsert: async (row: { id: string; value: unknown }) => {
        rows.set(row.id, row);
      },
    }),
  } as unknown as DataSource;
  const state = { enabled: true, providerEnabled: true, modelType: 'ocr' };
  const paddle = new PaddleOCRProvider({
    id: 'paddle',
    baseUrl: 'https://ocr.example/layout-parsing',
  });
  const mineru = new MinerUProvider({
    id: 'mineru',
    baseUrl: 'https://mineru.net',
    apiKey: 'synthetic-token',
  });
  const providers: ConstructorParameters<typeof ToolService>[1] = {
    getProvider: async () => {
      throw new Error('Unused');
    },
    getDefaults: async () => {
      throw new Error('No default OCR model');
    },
    getModel: async (ref) =>
      ({
        id: ref.split('/')[1],
        providerId: ref.split('/')[0],
        modelType: state.modelType,
        enabled: state.enabled,
        modalitiesInput: ['image', 'pdf'],
        modalitiesOutput: ['text'],
      }) as Awaited<ReturnType<typeof providers.getModel>>,
    getProviderInstance: async (id) => {
      if (!state.providerEnabled) throw new Error('Disabled provider');
      return id === 'paddle' ? paddle : mineru;
    },
  };
  const service = new ToolService(database, providers);
  assert.equal(
    (await service.update('read_file', defaultReadFileConfig)).config.enabled,
    true,
  );
  for (const model of ['mineru/vlm', 'paddle/PaddleOCR-VL']) {
    assert.equal(
      (await service.update('read_file', { ...config, model })).kind,
      'read_file',
    );
  }
  for (const patch of [
    { enabled: false },
    { modelType: 'language' },
    { providerEnabled: false },
  ]) {
    Object.assign(
      state,
      { enabled: true, modelType: 'ocr', providerEnabled: true },
      patch,
    );
    await assert.rejects(
      service.update('read_file', { ...config, model: 'paddle/PaddleOCR-VL' }),
      { code: 'INVALID_OCR_MODEL' },
    );
  }
  const saved = await service.get('read_file');
  assert.ok(saved.kind === 'read_file');
  assert.equal(saved.config.model, 'paddle/PaddleOCR-VL');
  await service.setEnabled('read_file', false);
  assert.deepEqual(
    await service.buildTools(['read_file'], { read_file: { enabled: true } }),
    {},
  );
  assert.deepEqual(
    await buildTools(['read_file'], { read_file: { enabled: false } }),
    {},
  );
});

test('read_file inherits the default OCR model, preserves explicit selections and reports missing defaults', async (t) => {
  const w = await workspace(t);
  let selected: string | null = null;
  let defaultReference: string | null = 'ocr/PaddleOCR-VL';
  const resolved: string[] = [];
  const providers = {
    getDefaults: async () => ({
      ...emptyModelDefaults,
      ocrModel: defaultReference,
    }),
    getModel: async (reference: string) => {
      resolved.push(reference);
      return {
        id: reference.split('/')[1],
        providerId: 'ocr',
        enabled: true,
        modelType: 'ocr',
        modalitiesOutput: ['text'],
      };
    },
    getProviderInstance: async () => ({
      type: 'paddleocr',
      ocrModel: (modelId: string) => ({
        provider: 'paddleocr',
        modelId,
        doOCR: async () => ({ markdown: '# Default OCR' }),
      }),
    }),
  } as unknown as ConstructorParameters<typeof ToolService>[1];
  const database = {
    getRepository: () => ({
      findOneBy: async () => ({
        value: { ...defaultReadFileConfig, model: selected },
      }),
    }),
  } as unknown as DataSource;
  const service = new ToolService(database, providers);
  async function read() {
    const tools = await service.buildTools(['read_file']);
    return runnable(tools.read_file as ReturnType<typeof createReadFileTool>)(
      { path: 'image.png' },
      w,
    );
  }
  let result = await read();
  assert.equal(result.ok, true);
  assert.equal(result.model, defaultReference);
  selected = 'ocr/explicit';
  result = await read();
  assert.equal(result.model, selected);
  assert.deepEqual(resolved, ['ocr/PaddleOCR-VL', 'ocr/explicit']);
  selected = null;
  defaultReference = null;
  assert.equal((await read()).code, 'OCR_NOT_CONFIGURED');
});
