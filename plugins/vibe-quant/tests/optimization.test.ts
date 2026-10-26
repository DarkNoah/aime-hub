import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { optimizationSchema } from '../server/strategies/optimization.js';
import { backtestSchema } from '../server/strategies/schema.js';
import { input } from './strategy-fixture.js';

const space = { fast: { type: 'int', low: 2, high: 10 } };
test('optimization supports typed search distributions and bounded defaults', () => {
  const config = optimizationSchema.parse({
    search_space: {
      ...space,
      risk: { type: 'float', low: 0.001, high: 0.1, log: true },
      trailing: { type: 'categorical', choices: [false, true] },
    },
  });
  assert.equal(config.n_trials, 30);
  assert.equal(config.seed, 42);
  assert.equal(config.metric, 'sharpe');
  assert.equal(config.timeout_seconds, 600);
  assert.equal(config.min_trades, 1);
});

test('rejects invalid distributions, reserved parameters and excessive server work', () => {
  for (const search_space of [
    {},
    { size: { type: 'int', low: 3, high: 2 } },
    { size: { type: 'int', low: 1.5, high: 2 } },
    { risk: { type: 'float', low: 0, high: 1, log: true } },
    { risk: { type: 'float', low: 1, high: 10, log: true, step: 1 } },
    { size: { type: 'int', low: 1, high: 10, log: true, step: 2 } },
    { choice: { type: 'categorical', choices: [] } },
    ...['symbol', 'duration', 'execution_model', '__proto__'].map((name) => ({
      [name]: space.fast,
    })),
  ])
    assert.equal(
      optimizationSchema.safeParse({ search_space }).success,
      false,
      JSON.stringify(search_space),
    );
  for (const option of [
    { n_trials: 201 },
    { timeout_seconds: 3601 },
    { min_trades: 0 },
    { seed: -1 },
  ])
    assert.equal(
      optimizationSchema.safeParse({ search_space: space, ...option }).success,
      false,
    );
});

test('holdout is strictly inside the fixed backtest interval and old runs stay valid', () => {
  const config = input(randomUUID());
  assert.equal(backtestSchema.parse(config).optimization, undefined);
  for (const validation_start of [config.start, config.end, config.end + 1])
    assert.equal(
      backtestSchema.safeParse({
        ...config,
        optimization: { search_space: space, validation_start },
      }).success,
      false,
    );
  const parsed = backtestSchema.parse({
    ...config,
    optimization: {
      search_space: space,
      validation_start: config.start + 3600,
    },
  });
  assert.equal(parsed.optimization?.n_trials, 30);
});
