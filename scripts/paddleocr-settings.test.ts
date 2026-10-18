import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createDataSource, Provider, ProviderModel, Setting } from '@aime/db';
import {
  emptyModelDefaults,
  modelInputSchema,
  modelReference,
  providerInputSchema,
  normalizeModelDefaults,
  modelDefaultsSchema,
} from '@aime/shared/providers';
import { ProviderService } from '../apps/server/src/modules/providers/service.js';
import { CreateProviderTables1780000001000 } from '../packages/db/src/migrations/1780000001000-create-provider-tables.js';
import { ProviderModelType1780000013000 } from '../packages/db/src/migrations/1780000013000-provider-model-type.js';
import { ProviderOcrModel1780000020000 } from '../packages/db/src/migrations/1780000020000-provider-ocr-model.js';
import { ProviderAsrModel1780000023000 } from '../packages/db/src/migrations/1780000023000-provider-asr-model.js';

test('legacy default settings acquire empty OCR and web defaults without losing existing choices', () => {
  const old = {
    defaultModel: 'provider/chat',
    fastModel: null,
    imageModel: null,
    thinkingMode: 'on',
  };
  assert.deepEqual(normalizeModelDefaults(old), {
    ...emptyModelDefaults,
    defaultModel: 'provider/chat',
    thinkingMode: 'medium',
  });
  const configured = {
    ...emptyModelDefaults,
    ocrModel: 'ocr/org/model',
    webSearchProviderId: 'search',
    webFetchProviderId: 'fetch',
  };
  assert.deepEqual(modelDefaultsSchema.parse(configured), configured);
  assert.deepEqual(normalizeModelDefaults(configured), configured);
});

test(
  'PostgreSQL PaddleOCR sync, resolution, edits and OCR type isolation',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = `paddleocr_test_${randomBytes(8).toString('hex')}`;
    const root = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      entities: [Provider, ProviderModel, Setting],
      migrations: [
        CreateProviderTables1780000001000,
        ProviderModelType1780000013000,
        ProviderOcrModel1780000020000,
        ProviderAsrModel1780000023000,
      ],
      extra: { options: `-c search_path=${schema}` },
    });
    let created = false;
    t.after(async () => {
      try {
        if (database.isInitialized) await database.destroy();
      } finally {
        try {
          if (created) await root.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await root.end();
        }
      }
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await database.initialize();
    await database.runMigrations();
    const calls: string[] = [];
    const resultUrl = 'https://cdn.example.test/paddle.jsonl';
    const service = new ProviderService(
      database,
      async () => {
        throw new Error('OCR sync must not query models.dev');
      },
      async (url) => {
        calls.push(url);
        const data =
          calls.length === 1
            ? { code: 0, data: { jobId: 'official-job' } }
            : calls.length === 2
              ? {
                  code: 0,
                  data: { state: 'done', resultUrl: { jsonUrl: resultUrl } },
                }
              : {
                  result: {
                    layoutParsingResults: [{ markdown: { text: '# Parsed' } }],
                  },
                };
        return {
          url,
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify(data)),
        };
      },
    );
    const provider = await service.createProvider(
      providerInputSchema.parse({
        name: 'PaddleOCR fixture',
        type: 'paddleocr',
        baseUrl: 'https://paddleocr.aistudio-app.com',
        apiKey: 'synthetic-token',
      }),
    );
    assert.deepEqual(await service.syncModels(provider.id), {
      added: 7,
      deprecated: 0,
      total: 7,
      catalogAvailable: false,
    });
    assert.equal(calls.length, 0);
    const saved = await service.getPublicProvider(provider.id);
    assert.equal(saved.models.length, 7);
    assert.ok(saved.models.every(({ modelType }) => modelType === 'ocr'));
    assert.ok(!JSON.stringify(saved).includes('synthetic-token'));
    const ref = modelReference(provider.id, 'PaddleOCR-VL-1.6');
    const model = await service.getOcrModel(ref);
    assert.equal(model.provider, 'paddleocr');
    assert.deepEqual(
      await model.doOCR({ input: { url: 'https://files.example.test/a.pdf' } }),
      {
        markdown: '# Parsed',
        resultUrl,
        taskId: 'official-job',
      },
    );
    assert.equal(calls.length, 3);
    assert.ok(
      (await service.listAvailableModels()).providers
        .find(({ id }) => id === provider.id)
        ?.models.every(({ modelType }) => modelType === 'ocr'),
    );
    await assert.rejects(
      service.createModel(
        provider.id,
        modelInputSchema.parse({
          id: 'chat',
          name: 'Chat',
        }),
      ),
      { code: 'INVALID_MODEL' },
    );
    await assert.rejects(
      service.updateModel(provider.id, model.modelId, {
        modelType: 'language',
      }),
      {
        code: 'INVALID_MODEL',
      },
    );
    for (const type of ['mineru', 'openai', 'serpapi'] as const) {
      await assert.rejects(service.updateProvider(provider.id, { type }), {
        code: 'PROVIDER_HAS_MODELS',
      });
    }
    await assert.rejects(
      service.setDefaults({ ...emptyModelDefaults, defaultModel: ref }),
      { code: 'INVALID_MODEL' },
    );
    const defaults = { ...emptyModelDefaults, ocrModel: ref };
    await service.setDefaults(defaults);
    assert.deepEqual(await service.getDefaults(), defaults);
    assert.equal((await service.getOcrModel()).modelId, model.modelId);
    for (const mutation of [
      () => service.updateModel(provider.id, model.modelId, { enabled: false }),
      () => service.deleteModel(provider.id, model.modelId),
      () => service.updateProvider(provider.id, { enabled: false }),
      () => service.deleteProvider(provider.id),
    ])
      await assert.rejects(mutation(), { code: 'MODEL_IN_USE' });
    const web = await service.createProvider(
      providerInputSchema.parse({
        name: 'Web defaults',
        type: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'synthetic-key',
      }),
    );
    const webDefaults = {
      ...defaults,
      webSearchProviderId: web.id,
      webFetchProviderId: web.id,
    };
    await service.setDefaults(webDefaults);
    assert.deepEqual(await service.getDefaults(), webDefaults);
    for (const mutation of [
      () => service.updateProvider(web.id, { enabled: false }),
      () => service.updateProvider(web.id, { type: 'openai' }),
      () => service.updateProvider(web.id, { apiKey: '' }),
      () => service.deleteProvider(web.id),
    ])
      await assert.rejects(mutation(), { code: 'MODEL_IN_USE' });
    for (const patch of [
      { webSearchProviderId: provider.id },
      { webFetchProviderId: 'missing' },
    ])
      await assert.rejects(service.setDefaults({ ...webDefaults, ...patch }), {
        code: 'INVALID_TOOL_PROVIDER',
      });
    await service.setDefaults(emptyModelDefaults);
    await service.updateProvider(web.id, { enabled: false });
    await assert.rejects(service.setDefaults(webDefaults), {
      code: 'INVALID_TOOL_PROVIDER',
    });
    await service.updateProvider(web.id, { enabled: true, apiKey: '' });
    await assert.rejects(service.setDefaults(webDefaults), {
      code: 'INVALID_TOOL_PROVIDER',
    });
    await service.deleteProvider(web.id);
    await service.updateModel(provider.id, model.modelId, {
      displayName: 'My parser',
      enabled: false,
    });
    assert.equal((await service.syncModels(provider.id)).added, 0);
    const edited = (await service.getPublicProvider(provider.id)).models.find(
      ({ id }) => id === model.modelId,
    )!;
    assert.equal(edited.displayName, 'My parser');
    assert.equal(edited.enabled, false);
    await assert.rejects(service.getOcrModel(ref), { code: 'INVALID_MODEL' });
    await service.updateProvider(provider.id, { enabled: false });
    await assert.rejects(
      service.getOcrModel(modelReference(provider.id, 'PP-StructureV3')),
      { code: 'INVALID_MODEL' },
    );
  },
);
