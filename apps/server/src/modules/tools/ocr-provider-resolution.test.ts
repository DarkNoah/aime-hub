import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { noopObserve } from '@mastra/core/tools';
import { defaultReadFileConfig } from '@aime/shared/tools';
import { emptyModelDefaults } from '@aime/shared/providers';
import { ToolService } from './service.js';
import { XinferenceProvider } from '../../mastra/providers/xinference.js';
import type { createReadFileTool } from '../../mastra/tools/read_file.js';

function fixture(type = 'xinference', enabled = true, modelType = 'ocr') {
  const reference = 'ocr/MiniCPM-OCR-1.0';
  let calls = 0;
  let saved: unknown;
  const provider = new XinferenceProvider(
    { id: 'ocr', baseUrl: 'https://ocr.example' },
    async (url, options) => {
      assert.equal(url, 'https://ocr.example/v1/documents/parse');
      const form = await new Response(new Uint8Array(options.body as Buffer), {
        headers: options.headers,
      }).formData();
      assert.equal(form.get('response_format'), 'md');
      calls++;
      return {
        url,
        status: 200,
        headers: { 'content-type': 'text/markdown' },
        body: Buffer.from(
          '# OCR invoice\n\n<table><tr><td>665.50</td></tr></table>',
        ),
      };
    },
  );
  const providers = {
    getDefaults: async () => ({ ...emptyModelDefaults, ocrModel: reference }),
    getModel: async () => ({
      id: 'MiniCPM-OCR-1.0',
      providerId: 'ocr',
      enabled,
      modelType,
      modalitiesOutput: ['text'],
    }),
    getProviderInstance: async () => ({
      type,
      ocrModel: provider.ocrModel.bind(provider),
    }),
  } as unknown as ConstructorParameters<typeof ToolService>[1];
  const database = {
    getRepository: () => ({
      findOneBy: async () => ({ value: defaultReadFileConfig }),
      upsert: async (value: unknown) => {
        saved = value;
      },
    }),
  } as unknown as DataSource;
  return {
    service: new ToolService(database, providers),
    reference,
    calls: () => calls,
    saved: () => saved,
  };
}

test('ToolService default Xinference OCR reaches multipart Markdown parsing through read_file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ocr-resolution-'));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'invoice.pdf'), '%PDF-1.4\n%%EOF');
  const f = fixture();
  const tools = await f.service.buildTools(['read_file']);
  const tool = tools.read_file as ReturnType<typeof createReadFileTool>;
  const result = await tool.execute!(
    { path: 'invoice.pdf', encoding: 'utf-8', showLineNumbers: false },
    { workspace, observe: noopObserve },
  );
  assert.ok(result && typeof result === 'object' && 'ok' in result);
  assert.equal(result.ok, true);
  assert.equal(result.model, f.reference);
  assert.equal(result.warnings, undefined);
  assert.match(result.content[0].text, /<table>/);
  assert.equal(f.calls(), 1);
});

test('explicit Xinference OCR config is accepted; unsupported providers and invalid models remain rejected', async () => {
  const f = fixture();
  await f.service.update('read_file', {
    ...defaultReadFileConfig,
    model: f.reference,
  });
  assert.ok(f.saved());
  for (const invalid of [
    fixture('newapi'),
    fixture('xinference', false),
    fixture('xinference', true, 'language'),
  ]) {
    await assert.rejects(
      invalid.service.update('read_file', {
        ...defaultReadFileConfig,
        model: invalid.reference,
      }),
      { code: 'INVALID_OCR_MODEL' },
    );
    assert.equal(invalid.saved(), undefined);
  }
});
