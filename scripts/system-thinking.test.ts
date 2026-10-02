import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyModelDefaults,
  modelDefaultsSchema,
  normalizeModelDefaults,
} from '@aime/shared/providers';
import { thinkingLevels } from '@aime/shared/threads';
import { getProviderOptions } from '../apps/server/src/modules/models/language-model.js';

test('system defaults accept every concrete level and reject legacy mode writes', () => {
  for (const thinkingMode of thinkingLevels)
    assert.equal(
      modelDefaultsSchema.safeParse({ ...emptyModelDefaults, thinkingMode })
        .success,
      true,
    );
  for (const thinkingMode of ['auto', 'on', 'off', 'invalid'])
    assert.equal(
      modelDefaultsSchema.safeParse({ ...emptyModelDefaults, thinkingMode })
        .success,
      false,
    );
});

test('persisted legacy modes normalize without losing model references', () => {
  for (const [legacy, expected] of [
    ['auto', 'medium'],
    ['on', 'medium'],
    ['off', 'none'],
  ]) {
    const defaults = normalizeModelDefaults({
      ...emptyModelDefaults,
      defaultModel: 'provider/model',
      thinkingMode: legacy,
    });
    assert.equal(defaults.thinkingMode, expected);
    assert.equal(defaults.defaultModel, 'provider/model');
  }
  assert.deepEqual(normalizeModelDefaults(null), emptyModelDefaults);
  assert.equal(
    normalizeModelDefaults({ ...emptyModelDefaults, thinkingMode: 'xhigh' })
      .thinkingMode,
    'xhigh',
  );
});

test('inherited effort uses each system level while explicit personal effort takes precedence', () => {
  for (const thinkingMode of thinkingLevels) {
    assert.equal(
      getProviderOptions({ reasoningEffort: 'auto', thinkingMode }).openai
        ?.reasoningEffort,
      thinkingMode,
    );
    assert.equal(
      getProviderOptions({ reasoningEffort: 'low', thinkingMode }).openai
        ?.reasoningEffort,
      'low',
    );
  }
  assert.deepEqual(
    getProviderOptions({
      reasoningEffort: 'auto',
      thinkingMode: 'high',
      reasoning: false,
    }),
    {},
  );
});
