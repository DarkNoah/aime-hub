import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createDataSource, CreateProviderTables1780000001000 } from '@aime/db';
import { ProviderModelType1780000013000 } from '../../../../../packages/db/src/migrations/1780000013000-provider-model-type.js';
import { ProviderAsrModel1780000023000 } from '../../../../../packages/db/src/migrations/1780000023000-provider-asr-model.js';
import { ProviderModel3d1780000041000 } from '../../../../../packages/db/src/migrations/1780000041000-provider-model3d.js';
import {
  emptyModelDefaults,
  modelReference,
  providerInputSchema,
} from '@aime/shared/providers';
import { ProviderService } from '../../modules/providers/service.js';
import { XinferenceProvider } from './xinference.js';
import type { ProviderConfiguration } from '@aime/shared/provider-configuration';

const testKey = 'synthetic-alibaba-test-key';
test(
  'Alibaba database migration, discovery, defaults and availability',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = `alibaba_test_${randomBytes(8).toString('hex')}`;
    const root = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
      migrations: [
        CreateProviderTables1780000001000,
        ProviderModelType1780000013000,
        ProviderAsrModel1780000023000,
        ProviderModel3d1780000041000,
      ],
    });
    let created = false;
    t.after(async () => {
      try {
        if (database.isInitialized) await database.destroy();
        if (created) await root.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await root.end();
      }
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await database.initialize();
    await database.runMigrations();
    const service = new ProviderService(database, async () => ({}));
    await t.test(
      'any provider can declare fields with normalized persistence and partial updates',
      async () => {
        const original = Object.getOwnPropertyDescriptor(
          XinferenceProvider,
          'configuration',
        )!;
        const configuration: ProviderConfiguration = {
          fields: [
            {
              key: 'tenantId',
              type: 'text',
              label: 'Tenant ID',
              required: true,
              pattern: '^[a-z]+$',
            },
            {
              key: 'retries',
              type: 'number',
              label: 'Retries',
              defaultValue: 0,
              min: 0,
              integer: true,
            },
            {
              key: 'streaming',
              type: 'switch',
              label: 'Streaming',
              defaultValue: true,
            },
            { key: 'note', type: 'textarea', label: 'Note' },
          ],
        };
        Object.defineProperty(XinferenceProvider, 'configuration', {
          value: configuration,
          configurable: true,
        });
        try {
          const input = providerInputSchema.parse({
            name: 'Dynamic Xinference',
            type: 'xinference',
            baseUrl: 'https://inference.example/v1',
            metadata: {
              tenantId: ' tenant ',
              note: 'old note',
              legacy: 'keep',
            },
          });
          const created = await service.createProvider(input);
          assert.deepEqual(created.metadata, {
            tenantId: 'tenant',
            retries: 0,
            streaming: true,
            note: 'old note',
            legacy: 'keep',
          });
          const updated = await service.updateProvider(created.id, {
            metadata: { streaming: false, note: null },
          });
          assert.deepEqual(updated.metadata, {
            tenantId: 'tenant',
            retries: 0,
            streaming: false,
            legacy: 'keep',
          });
          await service.updateProvider(created.id, { name: 'Renamed' });
          assert.deepEqual(
            (await service.getProviderInstance(created.id)).provider.metadata,
            updated.metadata,
          );
          for (const metadata of [
            { tenantId: '' },
            { tenantId: 'invalid/path' },
            { retries: -1 },
            { streaming: 'yes' },
          ]) {
            await assert.rejects(
              service.updateProvider(created.id, { metadata }),
              { code: 'VALIDATION_ERROR' },
            );
          }
          assert.deepEqual(
            (await service.getPublicProvider(created.id)).metadata,
            updated.metadata,
          );
        } finally {
          Object.defineProperty(XinferenceProvider, 'configuration', original);
        }
      },
    );
    const { id } = await service.createProvider(
      providerInputSchema.parse({
        name: 'Alibaba',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        type: 'alibaba-cn',
        apiKey: testKey,
        metadata: {
          workspaceId: 'workspace',
          region: 'cn-beijing',
          preserved: true,
        },
      }),
    );
    const synced = await service.syncModels(id);
    assert.ok(synced.added > 20);
    const saved = await service.getPublicProvider(id);
    assert.equal(
      saved.models.find((model) => model.id === 'qwen3-asr-flash')?.modelType,
      'asr',
    );
    assert.equal(
      saved.models.find((model) => model.id === 'qwen3-tts-flash')?.modelType,
      'speech',
    );
    assert.equal(
      saved.models.find((model) => model.id === 'Tripo/Tripo-H3.1')?.modelType,
      'model3d',
    );
    assert.ok(!JSON.stringify(saved).includes(testKey));
    const defaults = {
      ...emptyModelDefaults,
      speechModel: modelReference(id, 'qwen3-tts-flash'),
      asrModel: modelReference(id, 'qwen3-asr-flash'),
      model3dModel: modelReference(id, 'Tripo/Tripo-H3.1'),
    };
    await service.setDefaults(defaults);
    assert.equal((await service.get3DModel()).modelId, 'Tripo/Tripo-H3.1');
    assert.equal(
      ((await service.getSpeechModel()) as { modelId: string }).modelId,
      'qwen3-tts-flash',
    );
    assert.equal(
      ((await service.getTranscriptionModel()) as { modelId: string }).modelId,
      'qwen3-asr-flash',
    );
    await assert.rejects(service.get3DModel(defaults.speechModel), {
      code: 'INVALID_MODEL',
    });
    await assert.rejects(service.deleteModel(id, 'Tripo/Tripo-H3.1'), {
      code: 'MODEL_IN_USE',
    });
    await service.updateModel(id, 'Tripo/Tripo-H3.1', {
      displayName: 'Custom 3D name',
    });
    await service.syncModels(id);
    assert.equal(
      (await service.getModel(defaults.model3dModel)).displayName,
      'Custom 3D name',
    );
    await service.setDefaults(emptyModelDefaults);
    await service.updateProvider(id, {
      metadata: { workspaceId: 'workspace', region: 'ap-southeast-1' },
    });
    await service.syncModels(id);
    assert.equal(
      (await service.getModel(defaults.model3dModel)).deprecated,
      true,
    );
    await assert.rejects(
      service.get3DModel(defaults.model3dModel),
      /not supported/,
    );
    await service.updateProvider(id, { enabled: false });
    await assert.rejects(service.getTranscriptionModel(defaults.asrModel), {
      code: 'INVALID_MODEL',
    });
  },
);
