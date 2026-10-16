import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginLifecycle } from './lifecycle.js';

test('partial activation is cleaned up and cannot restart until cleanup succeeds', async () => {
  const calls: string[] = [];
  let failStart = true;
  let failStop = true;
  const lifecycle = new PluginLifecycle(
    new Map([
      [
        'example',
        {
          onEnable() {
            calls.push('enable');
            if (failStart) throw new Error('start');
          },
          onDisable() {
            calls.push('disable');
            if (failStop) throw new Error('stop');
          },
        },
      ],
    ]),
  );
  await assert.rejects(lifecycle.enable('example', '1'), /start/);
  assert.equal(lifecycle.isEnabled('example', '1'), false);
  assert.match(lifecycle.reason('example')!, /清理失败/);
  failStart = false;
  await assert.rejects(lifecycle.enable('example', '1'), /stop/);
  assert.deepEqual(calls, ['enable', 'disable', 'disable']);
  failStop = false;
  await lifecycle.enable('example', '1');
  await lifecycle.enable('example', '1');
  assert.deepEqual(calls, [
    'enable',
    'disable',
    'disable',
    'disable',
    'enable',
  ]);
  assert.equal(lifecycle.reason('example'), undefined);
  await lifecycle.dispose();
});

test('shutdown drains in reverse dependency order and attempts every finalizer after failures', async () => {
  const calls: string[] = [];
  const lifecycle = new PluginLifecycle(
    new Map([
      [
        'base',
        {
          onDisable() {
            calls.push('base.stop');
          },
          dispose: async () => {
            calls.push('base.dispose');
          },
        },
      ],
      [
        'dependent',
        {
          onDisable() {
            calls.push('dependent.stop');
            throw new Error('stop');
          },
          dispose: async () => {
            calls.push('dependent.dispose');
            throw new Error('dispose');
          },
        },
      ],
    ]),
  );
  await lifecycle.enable('base', '1');
  await lifecycle.enable('dependent', '1');
  await assert.rejects(
    lifecycle.dispose(),
    (error: unknown) =>
      error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(calls, [
    'dependent.stop',
    'dependent.dispose',
    'base.stop',
    'base.dispose',
  ]);
  assert.equal(lifecycle.isEnabled('dependent', '1'), false);
  assert.equal(lifecycle.isEnabled('base', '1'), false);
});
