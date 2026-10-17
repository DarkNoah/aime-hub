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
} from '@mastra/core/workspace';
import { AgentFSFilesystem } from '@mastra/agentfs';
import type { DataSource } from 'typeorm';
import { defaultViewFileConfig } from '@aime/shared/tools';
import { createViewFileTool } from '../../mastra/tools/view_file.js';
import type { OcrOptions } from '../../mastra/providers/ocr-model.js';
import { PaddleOCRProvider } from '../../mastra/providers/paddleocr.js';
import { MinerUProvider } from '../../mastra/providers/mineru.js';
import { maxBinaryFileBytes } from '../files/binary-file.js';
import { ToolService, buildTools } from './service.js';
import { parseViewFileOutput } from '../../../../web/src/components/chat/message-preview/view-file-output.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j01sAAAAASUVORK5CYII=',
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\n%%EOF');
const config = { ...defaultViewFileConfig, model: 'ocr/PaddleOCR-VL' };
function fixture(markdown = '# Parsed 12345') {
  const calls: OcrOptions[] = [];
  const tool = createViewFileTool(config, {
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
function runnable(tool: ReturnType<typeof createViewFileTool>) {
  type Execute = NonNullable<typeof tool.execute>;
  return async (
    input: Parameters<Execute>[0],
    context: Partial<Parameters<Execute>[1]> = {},
  ) => {
    const result = await tool.execute!(input, {
      observe: { span: async (_name, fn) => fn(), log: () => {} },
      ...context,
    });
    assert.ok(result && 'ok' in result);
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

test('view_file reads images, absolute workspace paths and uploaded paths, returning text and source metadata', async (t) => {
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
    createViewFileTool(config, {
      resolveModel: async () => ({ reference: config.model, model }),
    }),
  );
  assert.equal(
    (await execute({ path: 'document.pdf', page_ranges: '1' }, w)).code,
    'PAGE_RANGES_UNSUPPORTED',
  );
});

test('workspace boundaries, symlinks, invalid content and unsupported formats fail before contacting OCR', async (t) => {
  const w = await workspace(t);
  const f = fixture();
  await symlink(
    join(w.directory, 'image.png'),
    join(w.directory, 'linked.png'),
  );
  await writeFile(join(w.directory, 'invalid.png'), 'plain text');
  await writeFile(join(w.directory, 'empty.pdf'), '');
  await writeFile(join(w.directory, 'invalid.pdf'), png);
  await writeFile(join(w.directory, 'large.pdf'), pdf);
  await truncate(join(w.directory, 'large.pdf'), maxBinaryFileBytes + 1);
  for (const name of ['sound.wav', 'video.mp4', 'scene.glb', 'text.txt'])
    await writeFile(join(w.directory, name), 'x');
  const cases = [
    ['../outside.png', 'FILE_FORBIDDEN'],
    ['/etc/passwd', 'FILE_FORBIDDEN'],
    ['linked.png', 'FILE_SYMLINK'],
    ['missing.png', 'ENOENT'],
    ['invalid.png', 'FILE_INVALID_FORMAT'],
    ['invalid.pdf', 'FILE_INVALID_FORMAT'],
    ['empty.pdf', 'FILE_EMPTY'],
    ['large.pdf', 'FILE_TOO_LARGE'],
    ['sound.wav', 'FILE_TYPE_UNSUPPORTED'],
    ['video.mp4', 'FILE_TYPE_UNSUPPORTED'],
    ['scene.glb', 'FILE_TYPE_UNSUPPORTED'],
    ['text.txt', 'FILE_TYPE_UNSUPPORTED'],
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

test('view_file reads both local and AgentFS mounts in project workspaces', async (t) => {
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
  const unconfigured = runnable(createViewFileTool());
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
    const tool = createViewFileTool(
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
  await assert.rejects(service.update('view_file', defaultViewFileConfig), {
    code: 'INVALID_OCR_MODEL',
  });
  for (const model of ['mineru/vlm', 'paddle/PaddleOCR-VL']) {
    assert.equal(
      (await service.update('view_file', { ...config, model })).kind,
      'view_file',
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
      service.update('view_file', { ...config, model: 'paddle/PaddleOCR-VL' }),
      { code: 'INVALID_OCR_MODEL' },
    );
  }
  const saved = await service.get('view_file');
  assert.ok(saved.kind === 'view_file');
  assert.equal(saved.config.model, 'paddle/PaddleOCR-VL');
  await service.setEnabled('view_file', false);
  assert.deepEqual(
    await service.buildTools(['view_file'], { view_file: { enabled: true } }),
    {},
  );
  assert.deepEqual(
    await buildTools(['view_file'], { view_file: { enabled: false } }),
    {},
  );
});
