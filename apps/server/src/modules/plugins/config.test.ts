import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePluginConfig,
  pluginConfigFieldsSchema,
  isPluginConfigFieldVisible,
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

test('grouped select fields validate choices and conditional requirements without dropping hidden values', () => {
  const fields = pluginConfigFieldsSchema.parse([
    {
      key: 'engine',
      label: 'Engine',
      type: 'select',
      group: 'Source',
      default: 'tdx',
      options: [
        { value: 'tdx', label: 'TDX' },
        { value: 'tq', label: 'TQ' },
      ],
    },
    {
      key: 'token',
      label: 'Token',
      type: 'password',
      group: 'Account',
      required: true,
      visibleWhen: { field: 'engine', equals: 'tq' },
    },
  ]);
  assert.equal(fields[0].group, 'Source');
  assert.equal(isPluginConfigFieldVisible(fields[1], { engine: 'tdx' }), false);
  assert.deepEqual(parsePluginConfig(fields, {}), {
    success: true,
    data: { engine: 'tdx' },
  });
  assert.equal(parsePluginConfig(fields, { engine: 'unknown' }).success, false);
  assert.equal(
    parsePluginConfig(fields, { engine: 'tq', token: '' }).success,
    false,
  );
  assert.deepEqual(
    parsePluginConfig(fields, { engine: 'tdx', token: 'keep' }),
    { success: true, data: { engine: 'tdx', token: 'keep' } },
  );
  for (const change of [
    {
      options: [
        { value: 'a', label: 'A' },
        { value: 'a', label: 'Duplicate' },
      ],
    },
    { default: 'unknown' },
  ])
    assert.equal(
      pluginConfigFieldsSchema.safeParse([{ ...fields[0], ...change }]).success,
      false,
    );
  for (const condition of [
    { field: 'missing', equals: 'tq' },
    { field: 'engine', equals: true },
    { field: 'engine', equals: 'invalid' },
    { field: 'token', equals: 'secret' },
  ])
    assert.equal(
      pluginConfigFieldsSchema.safeParse([
        fields[0],
        { ...fields[1], visibleWhen: condition },
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
