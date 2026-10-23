import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseJsonFields,
  serializeJsonFields,
  jsonFieldsError,
} from '../../../apps/web/src/components/json-object-fields.js';
import { parseObject } from '../web/strategies/format.js';
import { draftSchema } from '../server/strategies/schema.js';

test('parameter form and JSON preserve types, nested values and literal property names', () => {
  const original = JSON.parse(
    '{"n":1.5,"zero":0,"text":"001","enabled":false,"nil":null,"nested":{"days":[1,"2",false]},"__proto__":{"value":1}}',
  );
  const source = JSON.stringify(original);
  const fields = parseJsonFields(source);
  assert.deepEqual(parseObject(serializeJsonFields(fields)), original);
  assert.equal(fields.find((field) => field.key === 'text')?.kind, 'string');
  assert.equal(
    fields.find((field) => field.key === 'enabled')?.kind,
    'boolean',
  );
  fields.find((field) => field.key === 'n')!.value = '2.75';
  fields.find((field) => field.key === 'enabled')!.value = 'true';
  assert.equal(parseObject(serializeJsonFields(fields)).n, 2.75);
  assert.equal(parseObject(serializeJsonFields(fields)).enabled, true);
  assert.deepEqual(parseJsonFields('{}'), []);
});

test('incomplete and non-finite parameter edits remain invalid instead of silently restoring old values', () => {
  const fields = parseJsonFields('{"quantity":1}');
  fields[0].value = '';
  assert.ok(jsonFieldsError(serializeJsonFields(fields)));
  assert.throws(() => parseObject(serializeJsonFields(fields)));
  for (const source of [
    '[]',
    'null',
    '2',
    '{',
    '{"n":1e309}',
    '{"nested":{"n":1e309}}',
  ]) {
    assert.ok(jsonFieldsError(source));
    assert.throws(() => parseObject(source));
  }
});

test('drafts expose source and parameters only and ignore retired entrypoint settings', () => {
  const draft = { source: 'class Orb(Strategy): pass', parameters: {} };
  assert.deepEqual(draftSchema.parse(draft), draft);
  assert.deepEqual(
    draftSchema.parse({ ...draft, entrypoint: 'OldClass' }),
    draft,
  );
  assert.equal(Object.hasOwn(draftSchema.shape, 'entrypoint'), false);
  assert.deepEqual(
    draftSchema
      .partial()
      .parse({ parameters: { quantity: 2 }, entrypoint: 'OldClass' }),
    {
      parameters: { quantity: 2 },
    },
  );
});
