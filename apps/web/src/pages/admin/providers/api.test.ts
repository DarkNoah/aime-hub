import { onModelsInvalidated } from '../../../features/models/resource';
import {
  modelOptions,
  groupModelOptions,
} from '../../../components/model-selector/model-options';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  modelInputSchema,
  modelUpdateSchema,
  providerInputSchema,
  providerUpdateSchema,
  type ProviderModel,
  type ProviderSummary,
} from '@aime/shared/providers';
import {
  modelFormInput,
  modelPath,
  providerErrorKey,
  providerFormInput,
  providerRequest,
} from './api';

function providerForm() {
  const form = new FormData();
  form.set('name', 'Example');
  form.set('baseUrl', 'https://example.com/v1');
  form.set('enabled', 'on');
  return form;
}
function modelForm() {
  const form = new FormData();
  form.set('id', 'openai/model');
  form.set('name', 'Model');
  form.set('enabled', 'on');
  form.set('modalitiesInput', 'text');
  form.set('modalitiesOutput', 'text');
  return form;
}

test('blank API key preserves the saved key; only a new key is sent', () => {
  const form = providerForm();
  assert.equal(Object.hasOwn(providerFormInput(form), 'apiKey'), false);
  for (const value of ['', '   ']) {
    form.set('apiKey', value);
    const patch = providerUpdateSchema.parse(providerFormInput(form));
    assert.equal(Object.hasOwn(patch, 'apiKey'), false);
  }
  // An obsolete clear control must never clear the saved key.
  form.set('clearApiKey', 'on');
  assert.equal(Object.hasOwn(providerFormInput(form), 'apiKey'), false);
  form.set('apiKey', ' new-secret ');
  assert.equal(providerFormInput(form).apiKey, 'new-secret');
});

test('provider metadata is omitted on edit and gets server defaults on create', () => {
  const form = providerForm();
  form.set('metadata', '{invalid json');
  const payload = providerFormInput(form);
  const patch = providerUpdateSchema.parse(payload);
  assert.equal(Object.hasOwn(patch, 'metadata'), false);
  assert.deepEqual(providerInputSchema.parse(payload).metadata, {});
  assert.equal(payload.enabled, true);
  form.delete('enabled');
  assert.equal(providerFormInput(form).enabled, false);
});

test('provider form rejects unsafe URLs', () => {
  for (const url of [
    'file:///tmp',
    'https://user:secret@example.com',
    'https://example.com?key=x',
    'https://example.com/#x',
  ]) {
    const form = providerForm();
    form.set('baseUrl', url);
    assert.throws(() => providerFormInput(form), { code: 'VALIDATION_ERROR' });
  }
});

test('model form validates editable capabilities without sending hidden fields', () => {
  const form = modelForm();
  let input = modelFormInput(form);
  for (const key of ['metadata', 'passTest', 'deprecated'])
    assert.equal(Object.hasOwn(input, key), false);
  assert.equal(input.limitContext, null);
  assert.equal(input.limitOutput, null);
  form.set('id', 'vendor/new-model');
  form.set('description', 'Description');
  form.set('displayName', 'Display');
  form.set('reasoning', 'on');
  form.set('toolCall', 'on');
  form.set('limitContext', '128000');
  form.set('limitOutput', '4096');
  form.append('modalitiesInput', 'image');
  form.set('modalitiesOutput', 'image');
  input = modelFormInput(form);
  assert.equal(input.id, 'vendor/new-model');
  assert.equal(input.name, 'Model');
  assert.equal(input.description, 'Description');
  assert.equal(input.displayName, 'Display');
  assert.equal(input.enabled, true);
  assert.equal(input.reasoning, true);
  assert.equal(input.toolCall, true);
  assert.equal(input.limitContext, 128000);
  assert.equal(input.limitOutput, 4096);
  assert.deepEqual(input.modalitiesInput, ['text', 'image']);
  assert.deepEqual(input.modalitiesOutput, ['image']);
  for (const invalid of ['0', '-1', '1.5', '2147483648', 'not-a-number']) {
    form.set('limitContext', invalid);
    assert.throws(() => modelFormInput(form), { code: 'VALIDATION_ERROR' });
  }
});

test('hidden model fields are omitted on edit and receive server defaults on create', () => {
  const form = modelForm();
  // Even stale form controls must not overwrite discovery metadata or stored test results.
  form.set('metadata', '{invalid json');
  form.set('deprecated', 'false');
  form.set('passTest', 'null');
  const payload = modelFormInput(form);
  const patch = modelUpdateSchema.parse(payload);
  for (const key of ['metadata', 'deprecated', 'passTest'])
    assert.equal(Object.hasOwn(patch, key), false);
  const created = modelInputSchema.parse(payload);
  assert.deepEqual(created.metadata, {});
  assert.equal(created.deprecated, null);
  assert.equal(created.passTest, null);
  form.delete('enabled');
  assert.equal(modelFormInput(form).enabled, false);
});

test('token presets and custom values persist, clearing either limit restores null', () => {
  const form = modelForm();
  for (const key of ['limitContext', 'limitOutput'] as const) {
    const presets =
      key === 'limitContext'
        ? [32, 64, 128, 256, 512]
        : [16, 32, 64, 128, 256, 512];
    for (const k of presets) {
      form.set(key, String(k * 1000));
      assert.equal(modelFormInput(form)[key], k * 1000);
    }
    form.set(key, '98304');
    assert.equal(modelFormInput(form)[key], 98304);
    form.set(key, '');
    assert.equal(modelFormInput(form)[key], null);
  }
});

test('slash and reserved characters in model IDs stay in an encoded query parameter', () => {
  const id = 'vendor/model?variant=1&name=#图像';
  assert.equal(
    modelPath('provider', id),
    `/api/admin/providers/provider/models?modelId=${encodeURIComponent(id)}`,
  );
  const url = new URL(modelPath('provider', id), 'https://example.com');
  assert.equal(url.pathname, '/api/admin/providers/provider/models');
  assert.equal(url.searchParams.get('modelId'), id);
  assert.equal(modelPath('provider'), '/api/admin/providers/provider/models');
});

test('default options require enabled providers and models; images require output, not input', () => {
  const base: ProviderSummary = {
    name: 'Provider',
    type: 'openai',
    baseUrl: 'https://example.com',
    enabled: true,
    metadata: {},
    id: 'p1',
    hasApiKey: false,
    modelCount: 4,
    createdAt: '',
    updatedAt: '',
  };
  const model: ProviderModel = {
    ...modelInputSchema.parse({
      id: 'vendor/text',
      name: 'Text',
      modalitiesInput: ['image'],
      modalitiesOutput: ['text'],
    }),
    providerId: 'p1',
    createdAt: '',
    updatedAt: '',
  };
  const models = [
    model,
    {
      ...model,
      id: 'image',
      modalitiesOutput: ['image'] as ProviderModel['modalitiesOutput'],
    },
    { ...model, id: 'disabled', enabled: false },
    { ...model, id: 'other', providerId: 'p2' },
  ];
  const providers = [base, { ...base, id: 'p2', enabled: false }];
  assert.deepEqual(
    modelOptions(providers, models).map((item) => item.value),
    ['p1/vendor/text', 'p1/image'],
  );
  assert.deepEqual(
    modelOptions(providers, models, true).map((item) => item.value),
    ['p1/image'],
  );
});

test('model selector groups by provider identity and searches names, IDs and descriptions', () => {
  const options = [
    {
      value: 'p1/vendor/shared',
      label: 'Cloud / Friendly name (vendor/shared)',
      providerId: 'p1',
      providerName: 'Cloud',
      id: 'vendor/shared',
      name: 'Original model',
      displayName: 'Friendly name',
      description: '中文 reasoning',
    },
    {
      value: 'p2/vendor/shared',
      label: 'Cloud / Other model (vendor/shared)',
      providerId: 'p2',
      providerName: 'Cloud',
      id: 'vendor/shared',
      name: 'Other model',
      displayName: 'Other model',
      description: null,
    },
  ];
  const groups = groupModelOptions(options);
  assert.deepEqual(
    groups.map((group) => group.id),
    ['p1', 'p2'],
  );
  assert.deepEqual(
    groups.flatMap((group) => group.models.map((model) => model.value)),
    ['p1/vendor/shared', 'p2/vendor/shared'],
  );
  assert.equal(groupModelOptions(options, '  CLOUD  ').length, 2);
  for (const query of ['cloud FRIENDLY', 'original', '中文', 'reasoning']) {
    assert.deepEqual(
      groupModelOptions(options, query).map((group) => group.id),
      ['p1'],
    );
  }
  assert.equal(groupModelOptions(options, 'vendor/shared').length, 2);
  assert.deepEqual(groupModelOptions(options, 'cloud missing'), []);
  assert.deepEqual(groupModelOptions([], ''), []);
  assert.deepEqual(groupModelOptions(options, '  '), groups);
});

test('all API error codes map to localized safe messages', () => {
  const expected = {
    VALIDATION_ERROR: 'errors.providerValidation',
    NOT_FOUND: 'errors.providerNotFound',
    CONFLICT: 'errors.providerConflict',
    MODEL_IN_USE: 'errors.modelInUse',
    INVALID_MODEL: 'errors.invalidModel',
    UPSTREAM_ERROR: 'errors.providerUpstream',
    INVALID_URL: 'errors.providerUrl',
    RATE_LIMITED: 'errors.rateLimit',
    FORBIDDEN: 'errors.forbidden',
    UNAUTHORIZED: 'errors.sessionExpired',
    INTERNAL_ERROR: 'errors.server',
  };
  for (const [code, key] of Object.entries(expected))
    assert.equal(providerErrorKey({ code }), key);
  assert.equal(providerErrorKey({ code: 'toString' }), 'errors.generic');
  assert.equal(
    providerErrorKey({ message: 'secret server details' }),
    'errors.generic',
  );
  assert.equal(
    providerErrorKey(new TypeError('fetch failed')),
    'errors.network',
  );
});

test('API consumes direct JSON, handles 204 and sends same-origin JSON requests', async (context) => {
  const responses = [
    new Response(JSON.stringify([{ id: 'p1' }])),
    new Response(null, { status: 204 }),
    new Response(JSON.stringify({ code: 'MODEL_IN_USE' }), { status: 409 }),
    new Response('no session', { status: 401 }),
  ];
  const calls: RequestInit[] = [];
  context.mock.method(
    globalThis,
    'fetch',
    async (_path: string, init: RequestInit) => {
      calls.push(init);
      return responses.shift()!;
    },
  );
  assert.deepEqual(await providerRequest('/api/admin/providers'), [
    { id: 'p1' },
  ]);
  assert.equal(
    await providerRequest(modelPath('p1', 'vendor/model'), {
      method: 'DELETE',
    }),
    undefined,
  );
  await assert.rejects(
    providerRequest('/api/admin/providers/p1', {
      method: 'PATCH',
      body: '{"enabled":false}',
    }),
    { code: 'MODEL_IN_USE' },
  );
  await assert.rejects(providerRequest('/api/admin/providers'), {
    code: 'UNAUTHORIZED',
  });
  assert.equal(calls[0].credentials, 'same-origin');
  assert.deepEqual(calls[2].headers, { 'Content-Type': 'application/json' });
});

test('successful provider writes invalidate the shared catalog; reads and failed writes do not', async (context) => {
  let invalidations = 0;
  const stop = onModelsInvalidated(() => invalidations++);
  context.after(stop);
  const responses = [
    Response.json([]),
    Response.json({}),
    new Response(null, { status: 204 }),
    Response.json({ code: 'CONFLICT' }, { status: 409 }),
  ];
  context.mock.method(globalThis, 'fetch', async () => responses.shift()!);
  await providerRequest('/api/admin/providers');
  assert.equal(invalidations, 0);
  await providerRequest(modelPath('p1'), { method: 'POST', body: '{}' });
  assert.equal(invalidations, 1);
  await providerRequest(modelPath('p1', 'model'), { method: 'DELETE' });
  assert.equal(invalidations, 2);
  await assert.rejects(
    providerRequest('/api/admin/providers', { method: 'POST', body: '{}' }),
  );
  assert.equal(invalidations, 2);
});
