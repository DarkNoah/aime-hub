import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createDataSource, Provider, ProviderModel, Setting } from '@aime/db';
import {
  emptyModelDefaults,
  modelReference,
  providerInputSchema,
} from '@aime/shared/providers';
import { ProviderService } from '../apps/server/src/modules/providers/service.js';
import { XinferenceProvider } from '../apps/server/src/mastra/providers/xinference.js';
import { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import { chatSettingsSchema } from '@aime/shared/threads';
import { CreateProviderTables1780000001000 } from '../packages/db/src/migrations/1780000001000-create-provider-tables.js';
import { ProviderModelType1780000013000 } from '../packages/db/src/migrations/1780000013000-provider-model-type.js';

test(
  'PostgreSQL Xinference discovery, defaults, resolution and reference protection',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = `xinference_test_${randomBytes(8).toString('hex')}`;
    const root = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      entities: [Provider, ProviderModel, Setting],
      migrations: [
        CreateProviderTables1780000001000,
        ProviderModelType1780000013000,
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
    const schemaChanges = await database.driver.createSchemaBuilder().log();
    assert.deepEqual(
      schemaChanges.upQueries.map((query) => query.query),
      [],
    );
    const service = new ProviderService(
      database,
      async () => ({}),
      async (url) => ({
        url,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            data: [
              { id: 'embed', model_type: 'embedding' },
              { id: 'rank', model_type: 'rerank' },
              {
                id: 'VoxCPM2',
                model_type: 'audio',
                model_ability: ['text2audio'],
              },
            ],
          }),
        ),
      }),
    );
    const provider = await service.createProvider(
      providerInputSchema.parse({
        name: 'Xinference fixture',
        type: 'xinference',
        baseUrl: 'http://inference.example.test:9997',
        apiKey: 'synthetic-key',
      }),
    );
    assert.ok(
      (await service.getProviderInstance(provider.id)) instanceof
        XinferenceProvider,
    );
    const sync = await service.syncModels(provider.id);
    assert.equal(sync.added, 3);
    const available = await service.listAvailableModels();
    assert.deepEqual(
      available.providers[0].models.map(({ modelType }) => modelType).sort(),
      ['embedding', 'rerank', 'speech'],
    );
    assert.equal(JSON.stringify(available).includes('synthetic-key'), false);

    await database.manager.save(Setting, {
      id: 'models',
      value: {
        defaultModel: null,
        fastModel: null,
        imageModel: null,
        thinkingMode: 'medium',
      },
    });
    assert.deepEqual(await service.getDefaults(), emptyModelDefaults);
    const defaults = {
      ...emptyModelDefaults,
      embeddingModel: modelReference(provider.id, 'embed'),
      rerankModel: modelReference(provider.id, 'rank'),
      speechModel: modelReference(provider.id, 'VoxCPM2'),
    };
    assert.deepEqual(await service.setDefaults(defaults), defaults);
    assert.deepEqual(
      await new ProviderService(database).getDefaults(),
      defaults,
    );
    for (const model of [
      await service.getEmbeddingModel(),
      await service.getRerankModel(),
      await service.getSpeechModel(),
    ])
      assert.equal(typeof model === 'object' && model.provider, 'xinference');
    await assert.rejects(
      service.setDefaults({
        ...defaults,
        defaultModel: defaults.embeddingModel,
      }),
      { code: 'INVALID_MODEL' },
    );
    await assert.rejects(
      service.setDefaults({ ...defaults, speechModel: defaults.rerankModel }),
      { code: 'INVALID_MODEL' },
    );
    await assert.rejects(
      new LanguageModelService(database, service).getLanguageModel(
        'test-user',
        chatSettingsSchema.parse({ model: defaults.embeddingModel }),
      ),
      { code: 'MODEL_UNAVAILABLE' },
    );
    for (const id of ['embed', 'rank', 'VoxCPM2']) {
      await assert.rejects(
        service.updateModel(provider.id, id, { enabled: false }),
        { code: 'MODEL_IN_USE' },
      );
      await assert.rejects(
        service.updateModel(provider.id, id, { modelType: 'language' }),
        { code: 'MODEL_IN_USE' },
      );
      await assert.rejects(service.deleteModel(provider.id, id), {
        code: 'MODEL_IN_USE',
      });
    }
    await assert.rejects(
      service.updateProvider(provider.id, { enabled: false }),
      { code: 'MODEL_IN_USE' },
    );
    await assert.rejects(service.deleteProvider(provider.id), {
      code: 'MODEL_IN_USE',
    });
    await service.setDefaults(emptyModelDefaults);
    await service.updateModel(provider.id, 'embed', { enabled: false });
    await assert.rejects(service.setDefaults(defaults), {
      code: 'INVALID_MODEL',
    });
    await service.deleteProvider(provider.id);
  },
);
