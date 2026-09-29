import assert from 'node:assert/strict';
import test from 'node:test';
import {
  modelInputSchema,
  type ProviderModel,
  type ProviderSummary,
} from '@aime/shared/providers';
import {
  modelFormInput,
  modelOptions,
  modelPath,
  providerErrorKey,
  providerFormInput,
  providerRequest,
} from './providers-api';

function providerForm() {
  const form = new FormData();
  form.set('name', 'Example');
  form.set('baseUrl', 'https://example.com/v1');
  form.set('metadata', '{"region":"local"}');
  form.set('enabled', 'on');
  return form;
}
function modelForm() {
  const form = new FormData();
  form.set('id', 'openai/model');
  form.set('name', 'Model');
  form.set('metadata', '{}');
  form.set('enabled', 'on');
  form.set('modalitiesInput', 'text');
  form.set('modalitiesOutput', 'text');
  form.set('passTest', 'null');
  form.set('deprecated', 'null');
  return form;
}

test('blank API key is omitted; explicit clear sends an empty string', () => {
  const form = providerForm();
  form.set('apiKey', '   ');
  assert.equal(Object.hasOwn(providerFormInput(form), 'apiKey'), false);
  form.set('apiKey', ' new-secret ');
  assert.equal(providerFormInput(form).apiKey, 'new-secret');
  form.set('clearApiKey', 'on');
  assert.equal(providerFormInput(form).apiKey, '');
});

test('provider metadata must be an object and unsafe URLs are rejected', () => {
  for (const metadata of ['[]', 'null', 'false', '"text"', '{']) {
    const form = providerForm();
    form.set('metadata', metadata);
    assert.throws(() => providerFormInput(form), { code: 'INVALID_METADATA' });
  }
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
  assert.deepEqual(providerFormInput(providerForm()).metadata, {
    region: 'local',
  });
});

test('model fields preserve null test state and support all editable capabilities', () => {
  const form = modelForm();
  let input = modelFormInput(form);
  assert.equal(input.passTest, null);
  assert.equal(input.deprecated, null);
  assert.equal(input.limitContext, null);
  assert.equal(input.limitOutput, null);
  form.set('id', 'vendor/new-model');
  form.set('description', 'Description');
  form.set('displayName', 'Display');
  form.set('passTest', 'false');
  form.set('deprecated', 'true');
  form.set('reasoning', 'on');
  form.set('toolCall', 'on');
  form.set('limitContext', '128000');
  form.set('limitOutput', '4096');
  form.append('modalitiesInput', 'image');
  form.set('modalitiesOutput', 'image');
  form.set('metadata', '{"custom":true}');
  input = modelFormInput(form);
  assert.equal(input.id, 'vendor/new-model');
  assert.equal(input.name, 'Model');
  assert.equal(input.description, 'Description');
  assert.equal(input.displayName, 'Display');
  assert.equal(input.enabled, true);
  assert.equal(input.passTest, false);
  assert.equal(input.deprecated, true);
  assert.equal(input.reasoning, true);
  assert.equal(input.toolCall, true);
  assert.equal(input.limitContext, 128000);
  assert.equal(input.limitOutput, 4096);
  assert.deepEqual(input.modalitiesInput, ['text', 'image']);
  assert.deepEqual(input.modalitiesOutput, ['image']);
  assert.deepEqual(input.metadata, { custom: true });
  for (const invalid of ['0', '-1', '1.5', '2147483648', 'not-a-number']) {
    form.set('limitContext', invalid);
    assert.throws(() => modelFormInput(form), { code: 'VALIDATION_ERROR' });
  }
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
