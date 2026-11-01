import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import type { Auth } from '@aime/auth';
import {
  parseProviderMetadata,
  providerMetadataFromForm,
  providerConfigFieldName,
  providerFieldText,
  type ProviderConfiguration,
} from '@aime/shared/provider-configuration';
import { providerTypeSchema } from '@aime/shared/providers';
import {
  getProviderConfigurations,
  createProviderInstance,
} from './registry.js';
import { XinferenceProvider } from './xinference.js';
import { ProviderService } from '../../modules/providers/service.js';
import { createApp } from '../../app.js';

const configuration: ProviderConfiguration = {
  fields: [
    {
      key: 'tenantId',
      type: 'text',
      label: { en: 'Tenant', 'zh-CN': '租户' },
      required: true,
      pattern: '^[a-z]+$',
    },
    { key: 'notes', type: 'textarea', label: 'Notes' },
    {
      key: 'attempts',
      type: 'number',
      label: 'Attempts',
      defaultValue: 0,
      min: 0,
      max: 10,
      integer: true,
    },
    {
      key: 'mode',
      type: 'select',
      label: 'Mode',
      defaultValue: 'fast',
      options: [
        { value: 'fast', label: 'Fast' },
        { value: 'full', label: 'Full' },
      ],
    },
    {
      key: 'enabledFlag',
      type: 'switch',
      label: 'Enabled',
      defaultValue: true,
    },
  ],
};

test('generic fields normalize types, defaults, explicit clearing and unowned metadata', () => {
  assert.deepEqual(
    parseProviderMetadata(configuration.fields, {
      tenantId: ' tenant ',
      extra: { keep: true },
    }),
    {
      tenantId: 'tenant',
      attempts: 0,
      mode: 'fast',
      enabledFlag: true,
      extra: { keep: true },
    },
  );
  assert.deepEqual(
    parseProviderMetadata(configuration.fields, {
      tenantId: 'tenant',
      notes: null,
      attempts: 0,
      enabledFlag: false,
    }),
    { tenantId: 'tenant', attempts: 0, mode: 'fast', enabledFlag: false },
  );
  assert.equal(
    providerFieldText(configuration.fields[0].label, 'zh-HK'),
    '租户',
  );
  assert.equal(
    providerFieldText(configuration.fields[0].label, 'fr'),
    'Tenant',
  );
  assert.equal(providerFieldText('Plain text', 'en'), 'Plain text');
});

test('browser FormData preserves false/zero and emits nulls to clear saved values', () => {
  const form = new FormData();
  form.set(providerConfigFieldName('tenantId'), 'tenant');
  form.set(providerConfigFieldName('attempts'), '0');
  form.set(providerConfigFieldName('mode'), 'full');
  form.set(providerConfigFieldName('notes'), '');
  const patch = providerMetadataFromForm(form, configuration.fields, {
    notes: 'old',
    extra: 'keep',
  });
  assert.equal(patch.notes, null);
  assert.equal(patch.enabledFlag, false);
  assert.equal(patch.attempts, 0);
  assert.equal(patch.extra, 'keep');
  assert.equal(
    Object.hasOwn(parseProviderMetadata(configuration.fields, patch), 'notes'),
    false,
  );
});

test('server validation rejects bad required, numeric, enum and switch values', () => {
  for (const patch of [
    { tenantId: '' },
    { tenantId: 'bad/name' },
    { attempts: '2' },
    { attempts: -1 },
    { attempts: 1.5 },
    { attempts: 11 },
    { attempts: Infinity },
    { mode: 'unknown' },
    { enabledFlag: 'true' },
  ])
    assert.throws(() =>
      parseProviderMetadata(configuration.fields, {
        tenantId: 'tenant',
        ...patch,
      }),
    );
  assert.throws(
    () =>
      parseProviderMetadata(
        [{ key: '__proto__', type: 'text', label: 'Invalid' }],
        {},
      ),
    /configuration key/,
  );
  assert.throws(
    () =>
      parseProviderMetadata(
        [configuration.fields[0], configuration.fields[0]],
        {},
      ),
    /configuration key/,
  );
});

test('a declaration on any registered provider automatically appears in discovery and runtime', (t) => {
  const original = Object.getOwnPropertyDescriptor(
    XinferenceProvider,
    'configuration',
  )!;
  Object.defineProperty(XinferenceProvider, 'configuration', {
    value: configuration,
    configurable: true,
  });
  t.after(() =>
    Object.defineProperty(XinferenceProvider, 'configuration', original),
  );
  const definitions = getProviderConfigurations();
  assert.deepEqual(
    Object.keys(definitions).sort(),
    [...providerTypeSchema.options].sort(),
  );
  assert.deepEqual(definitions.xinference, configuration);
  assert.equal(definitions.alibaba.fields[0].key, 'workspaceId');
  assert.deepEqual(definitions.openai.fields, []);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(definitions)));
  const modelProvider = createProviderInstance({
    id: 'provider',
    type: 'xinference',
    baseUrl: 'https://inference.example/v1',
    metadata: { tenantId: 'tenant' },
  });
  assert.ok(modelProvider instanceof XinferenceProvider);
  assert.equal(modelProvider.provider.metadata?.tenantId, 'tenant');
  const webProvider = createProviderInstance({
    id: 'search',
    type: 'serpapi',
    baseUrl: 'https://serpapi.com',
    metadata: { tenantId: 'tenant' },
  });
  assert.equal(webProvider.provider.metadata?.tenantId, 'tenant');
});

test('configuration discovery is admin-only and needs neither stored credentials nor provider construction', async () => {
  let role: string | undefined;
  const auth = {
    api: {
      getSession: async () => (role ? { user: { id: 'user', role } } : null),
    },
  } as unknown as Auth;
  const service = new ProviderService({} as DataSource);
  const app = createApp(auth, { service, webOrigin: 'http://localhost:5173' });
  const url = 'http://localhost/api/admin/provider-configurations';
  assert.equal((await app.request(url)).status, 401);
  role = 'user';
  assert.equal((await app.request(url)).status, 403);
  role = 'admin';
  const response = await app.request(url);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.xinference.fields, []);
  assert.equal(data['alibaba-cn'].fields[0].key, 'workspaceId');
  assert.ok(!JSON.stringify(data).includes('apiKey'));
});
