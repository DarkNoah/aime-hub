import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePluginConfig,
  pluginConfigFieldsSchema,
  type PluginConfig,
} from '@app/plugin-sdk';
import { PluginLifecycle } from './lifecycle.js';

test('configuration schema validates defaults, required values, limits and unknown keys', () => {
  const fields = pluginConfigFieldsSchema.parse([
    { key: 'token', label: 'Token', type: 'password', required: true },
    {
      key: 'limit',
      label: 'Limit',
      type: 'number',
      min: 1,
      max: 10,
      integer: true,
      default: 3,
    },
    { key: 'debug', label: 'Debug', type: 'boolean' },
  ]);
  assert.deepEqual(parsePluginConfig(fields, { token: 'abc' }), {
    success: true,
    data: { token: 'abc', limit: 3, debug: false },
  });
  for (const input of [
    {},
    { token: ' ' },
    { token: 'abc', limit: '3' },
    { token: 'abc', limit: 1.5 },
    { token: 'abc', limit: 11 },
    { token: 'abc', extra: true },
  ]) {
    assert.equal(parsePluginConfig(fields, input).success, false);
  }
  assert.equal(
    pluginConfigFieldsSchema.safeParse([
      { key: 'x', label: 'X', type: 'text' },
      { key: 'x', label: 'X2', type: 'text' },
    ]).success,
    false,
  );
  assert.equal(
    pluginConfigFieldsSchema.safeParse([
      { key: 'token', label: 'Token', type: 'password', default: 'leaked' },
    ]).success,
    false,
  );
  assert.equal(
    pluginConfigFieldsSchema.safeParse([
      { key: 'constructor', label: 'Bad key', type: 'text' },
    ]).success,
    false,
  );
  assert.equal(
    pluginConfigFieldsSchema.safeParse([
      { key: 'x', label: 'X', type: 'number', min: 3, max: 1 },
    ]).success,
    false,
  );
});

test('failed activation and retried cleanup receive the original immutable configuration', async () => {
  const configs: unknown[] = [];
  let failStop = true;
  const lifecycle = new PluginLifecycle(
    new Map([
      [
        'example',
        {
          onEnable({ config }: { config: PluginConfig }) {
            assert.equal(Object.isFrozen(config), true);
            configs.push(config);
            throw new Error('failed');
          },
          onDisable({ config }: { config: PluginConfig }) {
            configs.push(config);
            if (failStop) throw new Error('stop failed');
          },
        },
      ],
    ]),
  );
  const input = { value: 'original' };
  await assert.rejects(lifecycle.enable('example', '1', input));
  input.value = 'changed';
  failStop = false;
  await lifecycle.dispose();
  assert.deepEqual(configs, [
    { value: 'original' },
    { value: 'original' },
    { value: 'original' },
  ]);
});
