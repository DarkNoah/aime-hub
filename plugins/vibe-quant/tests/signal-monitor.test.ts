import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import { signalRoutes, monitorSchema } from '../server/signals/routes.js';
import { strategyDataRoutes } from '../server/sdk/routes.js';
import { monitorExecutionModel } from '../signal-types.js';
import { runSignalProcess } from '../server/signals/process.js';
import { input, start, actual } from './strategy-fixture.js';
import { StrategyStore } from '../server/strategies/store.js';
import type { StateStore } from '../server/state-store.js';
import type { QuantConfig } from '../server/config.js';
import { MonitorStore } from '../server/signals/store.js';
import { runInNewContext } from 'node:vm';
import { NotificationService } from '../../../apps/server/src/modules/notifications/service.js';
import type {
  NotificationStore,
  NotificationRecord,
} from '../../../apps/server/src/modules/notifications/store.js';

const config = () =>
  monitorSchema.parse({ ...input(randomUUID(), actual), warmup_days: 1 });
test('monitor creation uses shared strategies and enforces administrator, version binding and parameter validation', async () => {
  const value = config(),
    calls: unknown[] = [];
  let versionParameters: Record<string, unknown> = { lookback: 42 };
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'alice');
    c.set('isAdmin', c.req.header('admin') === 'yes');
    await next();
  });
  app.route(
    '/strategies',
    signalRoutes(() => ({
      config: { engine: 'tqsdk' } as QuantConfig,
      state: {
        instrument: async () => ({
          symbol: actual,
          kind: 'future',
          exchange: 'CFFEX',
          expired: false,
        }),
      } as unknown as StateStore,
      records: {
        storedStrategy: async () => ({ enabled: true, status: 'active' }),
        version: async () => ({
          strategy_id: 'strategy',
          number: 1,
          parameters: versionParameters,
        }),
      } as unknown as StrategyStore,
      monitors: {
        create: async (...args: unknown[]) => {
          calls.push(args);
          return { id: 'monitor' };
        },
      } as unknown as MonitorStore,
      wake: () => calls.push('wake'),
    })),
  );
  const request = (body: unknown, admin = 'yes', id = 'strategy') =>
    app.request(`/strategies/${id}/monitors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', admin },
      body: JSON.stringify(body),
    });
  assert.equal((await request(value, 'no')).status, 403);
  assert.equal((await request({ ...value, warmup_days: 0 })).status, 400);
  assert.equal((await request(value, 'yes', 'foreign')).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await request(value)).status, 201);
  assert.equal(calls.length, 2);
  assert.equal(
    (
      await request({
        version_id: value.version_id,
        symbol: value.symbol,
        duration: value.duration,
      })
    ).status,
    201,
  );
  const defaults = (calls[2] as unknown[])[4] as ReturnType<typeof config>;
  assert.deepEqual(
    defaults.parameters,
    { lookback: 42 },
    'minimal creation uses selected published version parameters',
  );
  assert.equal(defaults.version_id, value.version_id);
  assert.equal(defaults.duration, value.duration);
  assert.equal(defaults.initial_cash, 1_000_000);
  assert.equal(defaults.rules.lot_size, 1);
  assert.deepEqual(defaults.events, { entry: true, exit: true });
  assert.deepEqual(
    (calls[0] as unknown[])[4],
    value,
    'explicit legacy configuration remains intact',
  );
  versionParameters = { lookback: 42, duration: 300 };
  assert.equal(
    (
      await request({
        version_id: value.version_id,
        symbol: value.symbol,
        duration: 60,
      })
    ).status,
    201,
  );
  const fixed = (calls[4] as unknown[])[4] as ReturnType<typeof config>;
  assert.equal(
    fixed.duration,
    300,
    'published strategy duration takes priority over the chart in minimal market hints',
  );
  assert.equal(fixed.parameters.duration, 300);
  assert.equal((await request(value)).status, 201);
  assert.deepEqual(
    (calls[6] as unknown[])[4],
    value,
    'explicit legacy calculation inputs remain authoritative',
  );
  for (const duration of [undefined, 900, 86400]) {
    assert.equal(
      (
        await request({
          version_id: value.version_id,
          symbol: value.symbol,
          duration,
        })
      ).status,
      201,
    );
    assert.equal(
      ((calls.at(-2) as unknown[])[4] as ReturnType<typeof config>).duration,
      300,
      'market hints derive the strategy period even when an old client sends a different chart period',
    );
  }
  versionParameters = { lookback: 42 };
  assert.equal(
    (
      await request({
        version_id: value.version_id,
        symbol: value.symbol,
        duration: 900,
      })
    ).status,
    201,
  );
  assert.equal(
    ((calls.at(-2) as unknown[])[4] as ReturnType<typeof config>).duration,
    60,
    'versions without a configured duration use the SDK minute default, independently of chart period',
  );
});

for (const [monitorSymbol, executionModel] of [
  [actual, 'actual_contract'],
  ['KQ.m@CFFEX.IM', 'actual_contract'],
  ['KQ.m@CFFEX.IM', 'continuous_price'],
  ['SSE.000852', 'points'],
  ['SZSE.399006', 'points'],
] as const)
  test(
    `real Python ${monitorSymbol} ${executionModel}: full-history replay, entry/reversal/risk exits and checkpoint recovery`,
    { timeout: 45000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'signal-monitor-test-'));
      const sdk = fileURLToPath(new URL('../sdk', import.meta.url)),
        worker = fileURLToPath(
          new URL('../worker/strategy_monitor.py', import.meta.url),
        );
      const settings = { ...config(), execution_model: executionModel };
      const points = executionModel === 'points';
      const simulated = executionModel !== 'actual_contract';
      settings.symbol = monitorSymbol;
      settings.calendar = { ...settings.calendar, '2026-10-18': false };
      const source = `from quant_sdk import Strategy
class Signals(Strategy):
    def on_start(self, ctx):
        self._duration = int(ctx.params['duration'])
        ctx.state['n'] = 0
        if ctx.params['execution_model'] in ('continuous_price', 'points'):
            assert ctx.mode == 'backtest'
            assert ctx.data.instrument(ctx.params['symbol']).kind == 'future'
        ctx.data.subscribe(ctx.params['symbol'], 60)
    def on_bar(self, ctx, bar):
        if bar.duration != self._duration:
            return
        contract = ctx.data.resolve_contract(bar.symbol)
        n = ctx.state.get('n', 0) + 1
        ctx.state['n'] = n
        if n == 1:
            ctx.orders.target_position(contract, 1, reason='entry')
        elif n == 2:
            entry = ctx.orders.target_position(contract, -1, reason='reverse')
            ctx.set_risk_levels(contract, entry_id=entry, stop_loss=105)
`;
      const cutoff = start + 120;
      const bar = (time: number, high = 102) => ({
        symbol: actual,
        duration: 60,
        time,
        open: 100,
        high,
        low: 99,
        close: 101,
        volume: points ? 0 : 10000,
      });
      const chartBar = (value: ReturnType<typeof bar>, symbol: string) => ({
        ...value,
        symbol,
        ...(symbol.startsWith('KQ.m@') && !simulated
          ? {
              open: value.open + 20,
              high: value.high + 20,
              low: value.low + 20,
              close: value.close + 20,
            }
          : {}),
      });
      const warmup = [bar(start), bar(start + 60)];
      const live = [bar(cutoff), bar(cutoff + 60), bar(cutoff + 120, 106)];
      let checkpoint: unknown,
        ready = 0;
      const overlays: {
        levels: {
          stop_loss: number | null;
          chart_stop_loss: number | null;
          chart_time: number;
        }[];
      }[] = [];
      const signals: Record<string, unknown>[] = [];
      const history = new Map<string, Record<string, unknown>>();
      const summaries: Record<string, unknown>[] = [];
      async function execute(resume: boolean) {
        const abort = new AbortController();
        let polled = 0;
        const timer = setTimeout(() => abort.abort(), 15000);
        try {
          await assert.rejects(
            runSignalProcess(
              'python3',
              [worker, sdk, directory],
              directory,
              abort.signal,
              async (message) => {
                if (message.kind === 'history') {
                  const batch = message.batch as {
                    records: {
                      id: string;
                      kind: string;
                      payload: Record<string, unknown>;
                    }[];
                    summary?: Record<string, unknown>;
                  };
                  for (const row of batch.records)
                    history.set(row.kind + row.id, row.payload);
                  if (batch.summary) summaries.push(batch.summary);
                  return true;
                }
                if (message.kind === 'overlay') {
                  overlays.push(message.overlay as (typeof overlays)[number]);
                  return true;
                }
                if (message.kind === 'checkpoint') {
                  checkpoint = message.checkpoint;
                  return true;
                }
                if (message.kind === 'ready') {
                  ready++;
                  if (resume) setTimeout(() => abort.abort(), 20);
                  return true;
                }
                if (message.kind === 'signal') {
                  signals.push(message.signal as Record<string, unknown>);
                  if (signals.length === 1) setTimeout(() => abort.abort(), 20);
                  return true;
                }
                const path = String(message.path);
                if (path.startsWith('/instruments/'))
                  return {
                    symbol: decodeURIComponent(path.split('/').at(-1)!),
                    kind: path.includes('KQ')
                      ? 'continuous'
                      : points
                        ? 'stock'
                        : 'future',
                    priceTick: 0.2,
                  };
                if (path === '/sessions' && message.method === 'POST')
                  return {
                    id: 'a1',
                    cursor: '0',
                    serverTime: resume ? cutoff + 181 : cutoff,
                    engine: 'tqsdk',
                    initialQuotes:
                      monitorSymbol === actual
                        ? []
                        : [
                            {
                              symbol: monitorSymbol,
                              time: cutoff,
                              underlying: actual,
                              last: 100,
                            },
                          ],
                  };
                if (path === '/sessions/a1' && message.method === 'DELETE')
                  return {};
                if (path === '/contracts') {
                  assert.equal(
                    simulated,
                    false,
                    'main-price simulation never requires actual mapping',
                  );
                  return {
                    mappings: [{ time: start - 86400, underlying: actual }],
                    next: null,
                  };
                }
                if (path === '/history/range') return { start, end: cutoff };
                if (path === '/history') {
                  if (simulated)
                    assert.equal(
                      (message.params as { execution_model: string })
                        .execution_model,
                      executionModel,
                    );
                  return {
                    bars: (resume ? [...warmup, ...live] : warmup).map((bar) =>
                      chartBar(
                        bar,
                        (message.params as { symbol: string }).symbol,
                      ),
                    ),
                    next: null,
                  };
                }
                if (path === '/sessions/a1/events') {
                  polled++;
                  return {
                    cursor: String(polled),
                    status: { state: 'syncing' },
                    batches:
                      polled === 1
                        ? live.map((bar) => ({
                            quotes: [],
                            bars:
                              monitorSymbol === actual
                                ? [bar]
                                : [bar, chartBar(bar, monitorSymbol)],
                            receivedAt: bar.time + 60,
                          }))
                        : [],
                  };
                }
                throw new Error(`Unexpected ${path}`);
              },
            ),
            /用户中止/,
          );
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        await writeFile(join(directory, 'strategy.py'), source);
        await writeFile(
          join(directory, 'config.json'),
          JSON.stringify(settings),
        );
        await execute(false);
        assert.deepEqual(
          signals.map((v) => [v.type, v.side]),
          [['exit', 'short']],
          'past entries are saved without notifying',
        );
        assert.deepEqual(
          [...history.entries()]
            .filter(([id]) => id.startsWith('signal'))
            .map(([, v]) => [v.type, v.side]),
          [
            ['entry', 'long'],
            ['exit', 'long'],
            ['entry', 'short'],
            ['exit', 'short'],
          ],
        );
        assert.equal(
          [...history.keys()].filter((id) => id.startsWith('trade')).length,
          2,
        );
        assert.ok(
          summaries.some(
            (value) => (value.open_trades as unknown[]).length > 0,
          ),
          'current positions remain visible',
        );
        assert.equal(
          (summaries.at(-1)?.metrics as { trade_count: number }).trade_count,
          2,
        );
        assert.equal((summaries.at(-1)?.open_trades as unknown[]).length, 0);
        assert.ok(
          [...history.values()].some((value) =>
            (
              value as { risk_levels?: { stop_loss: number }[] }
            ).risk_levels?.some((level) => level.stop_loss === 105),
          ),
          'closed monitor trades retain the protection path after leaving the position',
        );
        assert.ok(checkpoint);
        assert.equal(summaries.at(-1)?.execution_model, executionModel);
        if (points) {
          const summary = summaries.at(-1)!;
          assert.equal(summary.pnl_unit, 'points');
          const metrics = summary.metrics as Record<string, number | null>;
          assert.equal(metrics.total_return, null);
          assert.equal(metrics.max_drawdown, null);
          assert.ok(Number.isFinite(metrics.total_points));
          assert.ok(Number.isFinite(metrics.max_drawdown_points));
          assert.ok(
            [...history.entries()]
              .filter(([id]) => id.startsWith('trade'))
              .every(([, trade]) => trade.quantity === 1),
          );
        }
        assert.ok(
          overlays.some((value) =>
            value.levels.some((level) => level.stop_loss === 105),
          ),
        );
        assert.equal(
          overlays.at(-1)?.levels.length,
          0,
          'exit clears protection lines',
        );
        assert.equal(signals[0].chart_time, cutoff + 120);
        await writeFile(
          join(directory, 'checkpoint.json'),
          JSON.stringify(checkpoint),
        );
        await execute(true);
        assert.equal(ready, 2);
        assert.equal(
          signals.length,
          1,
          'recovery never replays historical notifications',
        );
        const saved = checkpoint as {
          history_version: number;
          runner: { manifest: { runtime_hash: string } };
        };
        assert.equal(saved.history_version, 3);
        // Old checkpoints need a fresh replay under the corrected SDK. Do not
        // bypass the fingerprint check to reuse an incompatible runner state.
        const legacy = structuredClone(saved);
        legacy.history_version = 2;
        legacy.runner.manifest.runtime_hash = 'previous-sdk';
        const priorHistory = [...history.entries()];
        const priorMetrics = summaries.at(-1)?.metrics;
        await writeFile(
          join(directory, 'checkpoint.json'),
          JSON.stringify(legacy),
        );
        await execute(true);
        assert.equal(ready, 3);
        assert.equal(
          signals.length,
          1,
          'legacy replay does not send historical notifications',
        );
        assert.deepEqual(
          [...history.entries()],
          priorHistory,
          'legacy replay reuses stable record IDs',
        );
        assert.deepEqual(summaries.at(-1)?.metrics, priorMetrics);
        assert.equal((checkpoint as typeof saved).history_version, 3);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

test(
  'real ClickHouse: owner isolation, bounded configuration, concurrent leases, checkpoint fencing and signal deduplication',
  { skip: process.env.QUANT_SIGNAL_INTEGRATION !== '1', timeout: 60000 },
  async () => {
    const database = `signal_test_${randomUUID().replaceAll('-', '')}`;
    const store = new MonitorStore(
      {
        clickhouseUrl: 'http://127.0.0.1:18124',
        clickhouseDatabase: database,
        clickhouseUser: 'test',
        clickhousePassword: 'test-only-local',
      } as QuantConfig,
      'service-a',
    );
    await store.request(`CREATE DATABASE ${database}`);
    try {
      await store.initialize();
      const records = new StrategyStore({
        clickhouseUrl: 'http://127.0.0.1:18124',
        clickhouseDatabase: database,
        clickhouseUser: 'test',
        clickhousePassword: 'test-only-local',
      } as QuantConfig);
      await records.initialize();
      const strategy = await records.save('alice', {
        name: 'history scope',
        description: '',
        enabled: true,
        draft: { source: 'class Test: pass', parameters: {} },
      });
      const { version } = await records.publish(
        'alice',
        strategy.id,
        strategy.revision,
        '',
      );
      const historyConfig = input(version.id, actual);
      const historyRows = Array.from({ length: 36 }, (_, i) => ({
        id: randomUUID(),
        strategy_id: strategy.id,
        version_id: i === 0 ? version.id : randomUUID(),
        engine: 'tqsdk',
        config: historyConfig,
        created_at: new Date((start + i) * 1000).toISOString(),
        status: 'completed',
      }));
      await records.request(
        `INSERT INTO ${database}.quant_strategy_runs FORMAT JSONEachRow`,
        {},
        historyRows
          .map((value) =>
            JSON.stringify({
              id: value.id,
              userId: 'alice',
              revision: 1,
              payload: JSON.stringify(value),
            }),
          )
          .join('\n'),
      );
      const selectedHistory = await records.runs(
        'alice',
        strategy.id,
        undefined,
        'backtest',
        {
          engine: 'tqsdk',
          config: {
            ...historyConfig,
            warmup_days: 7,
            events: { entry: true, exit: true },
          },
        },
      );
      assert.deepEqual(
        selectedHistory.map((row) => row.id),
        [historyRows[0].id],
        'filter happens before the 30-record page limit',
      );
      assert.equal((await records.runs('bob', strategy.id)).length, 30);
      const row = await store.create('alice', 'strategy', 1, 'tqsdk', config());
      assert.equal(row.status, 'starting');
      assert.equal((await store.list('bob')).length, 0);
      await assert.rejects(store.get(row.id, 'bob'), /MONITOR_NOT_FOUND/);
      assert.equal(await store.acquire(row.id, 'fresh-schema'), true);
      assert.equal(
        await store.heartbeat(
          row.id,
          'fresh-schema',
          'paused',
          '',
          undefined,
          true,
        ),
        true,
      );
      // Production can retain this legacy column after checkpoints moved to a
      // separate table. Both leasing and renewal must tolerate the old layout.
      await store.request(
        `ALTER TABLE ${database}.quant_signal_runtime ADD COLUMN checkpoint String AFTER message`,
      );
      const leases = await Promise.all([
        store.acquire(row.id, 'worker-a'),
        store.acquire(row.id, 'worker-b'),
      ]);
      assert.equal(leases.filter(Boolean).length, 1);
      const owner = leases[0] ? 'worker-a' : 'worker-b',
        other = leases[0] ? 'worker-b' : 'worker-a';
      const checkpoint = JSON.stringify({ state: '预热'.repeat(500000) });
      assert.equal(
        await store.heartbeat(row.id, owner, 'running', '监听中', checkpoint),
        true,
      );
      const slowWriter = store
        .execute('SELECT sleep(2)', {}, undefined, `signal-monitor:${row.id}`)
        .then(() => 'writer');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const renewal = store
        .heartbeat(row.id, owner, 'running', '监听中')
        .then((renewed) => {
          assert.equal(renewed, true);
          return 'renewal';
        });
      assert.equal(
        await Promise.race([slowWriter, renewal]),
        'renewal',
        'large history/checkpoint writes must not block lease renewal',
      );
      await slowWriter;
      const overlay = { updated_at: start, levels: [] };
      assert.equal(await store.saveOverlay(row.id, owner, overlay), true);
      assert.deepEqual(await store.overlay(row.id), overlay);
      assert.equal(
        await store.saveOverlay(row.id, other, {
          updated_at: start + 1,
          levels: [],
        }),
        false,
      );
      assert.deepEqual(await store.overlay(row.id), overlay);
      assert.equal((await store.runtime(row.id))?.checkpoint, '');
      assert.equal((await store.runtime(row.id, true))?.checkpoint, checkpoint);
      assert.equal(
        await store.heartbeat(row.id, other, 'running', '', checkpoint),
        false,
      );
      assert.equal(
        await store.heartbeat(row.id, owner, 'paused', '暂停', undefined, true),
        true,
      );
      assert.equal(await store.acquire(row.id, other), true);
      assert.equal(
        await store.heartbeat(
          row.id,
          owner,
          'running',
          '',
          JSON.stringify({ stale: true }),
        ),
        false,
      );
      assert.equal((await store.runtime(row.id, true))?.checkpoint, checkpoint);
      const signal = {
        id: 'event-a',
        monitor_id: row.id,
        type: 'entry' as const,
        side: 'long' as const,
        symbol: actual,
        time: start,
        price: 100,
        reason: '入场',
      };
      await Promise.all([
        store.signal('alice', signal, other),
        store.signal('alice', signal, other),
      ]);
      assert.equal((await store.signals('alice', row.id)).length, 1);
      await assert.rejects(store.signals('bob', row.id), /MONITOR_NOT_FOUND/);
      const edits = await Promise.allSettled([
        store.update('alice', row.id, 1, false),
        store.update('alice', row.id, 1, false),
      ]);
      assert.equal(
        edits.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const muted = await store.update('alice', row.id, 2, true, false, {
        notifications_enabled: false,
        notifications: {
          channels: {
            toast: { enabled: true },
            future: { enabled: false, option: 'saved' },
          },
        },
      });
      assert.equal(muted.enabled, true);
      assert.equal(
        (await store.get(row.id, 'alice')).notifications_enabled,
        false,
      );
      assert.equal(
        (await store.get(row.id, 'alice')).notifications?.channels.future
          .option,
        'saved',
      );
      const batch = {
        records: Array.from({ length: 65 }, (_, index) => ({
          kind: 'trade' as const,
          id: `trade-${index}`,
          time: start + Math.floor(index / 2),
          payload: {
            id: `trade-${index}`,
            entry_time: start + Math.floor(index / 2) - 2,
            exit_time: start + Math.floor(index / 2),
            risk_levels: [
              { id: 'saved-risk', stop_loss: 99, take_profit: 105 },
            ],
          },
        })),
      };
      await store.history.save(row.id, other, batch);
      await store.history.save(row.id, other, batch);
      const first = await store.history.read(row.id);
      assert.equal(first.trades.length, 50);
      assert.ok(first.next);
      const second = await store.history.read(row.id, first.next!);
      assert.equal(second.trades.length, 15);
      assert.equal(
        new Set([...first.trades, ...second.trades].map((t) => t.id)).size,
        65,
      );
      await store.history.save(row.id, other, {
        records: [
          {
            kind: 'summary',
            id: 'summary',
            time: start + 25,
            payload: {
              open_trades: [
                {
                  id: 'open-in-range',
                  status: 'open',
                  entry_time: start + 19,
                  observed_until: start + 25,
                },
                {
                  id: 'open-outside',
                  status: 'open',
                  entry_time: start + 10,
                  observed_until: start + 18,
                },
              ],
            },
          },
        ],
      });
      const chart = await store.history.chart(row.id, {
        from: start + 20,
        to: start + 21,
      });
      assert.equal(
        chart.trades.length,
        7,
        'range includes overlapping holdings and current open positions',
      );
      assert.equal(chart.trades_truncated, false);
      assert.ok(chart.trades.find((t) => t.id === 'open-in-range'));
      assert.equal(chart.trades[0].risk_levels?.[0].stop_loss, 99);
      await store.history.save(row.id, other, {
        records: Array.from({ length: 55 }, (_, index) => ({
          kind: 'signal' as const,
          id: `signal-${index}`,
          time: start + index,
          payload: { ...signal, id: `signal-${index}`, time: start + index },
        })),
      });
      const signalFirst = await store.history.read(row.id);
      assert.equal(signalFirst.signals.length, 50);
      assert.ok(signalFirst.signals_next);
      const signalOlder = await store.history.read(
        row.id,
        undefined,
        signalFirst.signals_next!,
      );
      assert.equal(signalOlder.signals.length, 6);
      assert.equal(
        new Set(
          [...signalFirst.signals, ...signalOlder.signals].map((row) => row.id),
        ).size,
        56,
      );
      await assert.rejects(
        store.history.read(row.id, 'invalid'),
        /INVALID_MONITOR_CONFIG/,
      );
      await assert.rejects(store.history.save(row.id, owner, batch), /租约/);
      const removed = await store.update(
        'alice',
        row.id,
        muted.revision,
        false,
        true,
      );
      assert.equal(await store.acquire(row.id, other), false);
      assert.equal(
        await store.heartbeat(row.id, other, 'running', '', 'late checkpoint'),
        false,
      );
      assert.equal(await store.saveOverlay(row.id, other, overlay), false);
      await assert.rejects(store.history.save(row.id, other, batch), /租约/);
      await assert.rejects(store.signal('alice', signal, other), /租约/);
      for (const table of [
        'quant_signal_history',
        'quant_signal_events',
        'quant_signal_runtime',
        'quant_signal_checkpoints',
        'quant_signal_overlays',
      ]) {
        const [count] = await store.rows<{ count: string }>(
          `SELECT count() AS count FROM ${database}.${table}`,
        );
        assert.equal(Number(count.count), 0, table + ' must be cleared');
      }
      await store.update('alice', row.id, removed.revision, false, true);
      assert.equal(
        (await records.runs('alice', strategy.id)).length,
        30,
        'normal backtests remain independent',
      );
      const readded = await store.create(
        'alice',
        'strategy',
        1,
        'tqsdk',
        config(),
      );
      assert.notEqual(readded.id, row.id);
      assert.equal((await store.history.read(readded.id)).summary, null);
      assert.equal((await store.history.read(readded.id)).trades.length, 0);
      assert.equal(await store.runtime(readded.id, true), undefined);
      const creates = await Promise.allSettled(
        Array.from({ length: 9 }, () =>
          store.create('alice', 'strategy', 1, 'tqsdk', config()),
        ),
      );
      assert.equal(
        creates.filter((result) => result.status === 'fulfilled').length,
        7,
      );
      assert.equal((await store.list('alice')).length, 8);
    } finally {
      await store.request(`DROP DATABASE ${database}`);
    }
  },
);

test('host notification channels deduplicate per owner and Service Worker shows the strategy signal only to that account', async () => {
  const records: NotificationRecord[] = [];
  let pushes = 0;
  const service = new NotificationService(
    {
      async put(record: NotificationRecord) {
        if (
          records.some(
            (item) => item.notification.id === record.notification.id,
          )
        )
          return false;
        records.push(record);
        return true;
      },
      async recipients() {
        return [{}];
      },
    } as unknown as NotificationStore,
    {
      publicKey: 'test',
      async send() {
        pushes++;
      },
    },
  );
  const input = {
    userId: 'alice',
    eventId: 'same-event',
    title: '策略 · 多头入场信号',
    body: 'CFFEX.IM2611 · 参考价 8000',
    url: '/plugins/vibe-quant/strategies?strategy=test',
    toast: false,
    desktop: true,
  };
  await service.publishPlugin('vibe-quant', input);
  await service.publishPlugin('vibe-quant', input);
  await service.publishPlugin('vibe-quant', {
    ...input,
    userId: 'bob',
    toast: true,
    desktop: false,
  });
  await service.publishPlugin('vibe-quant', {
    ...input,
    eventId: 'off',
    toast: false,
    desktop: false,
  });
  assert.equal(records.length, 2);
  await service.publishPlugin('vibe-quant', {
    ...input,
    eventId: 'sound-only',
    toast: false,
    desktop: false,
    sound: 'entry',
  });
  const audible = records.at(-1)!.notification;
  assert.ok('kind' in audible);
  assert.equal(audible.sound, 'entry');
  assert.equal(audible.toast, false);
  assert.equal(records.length, 3);
  await service.settled();
  assert.equal(pushes, 1);
  assert.notEqual(records[0].notification.id, records[1].notification.id);
  await assert.rejects(
    service.publishPlugin('vibe-quant', { ...input, url: '/admin' }),
    /Invalid/,
  );
  const notification = records[0].notification;
  assert.ok('kind' in notification);
  assert.equal(notification.toast, false);
  type WorkerEvent = {
    data: { json: () => unknown };
    waitUntil: (promise: Promise<void>) => void;
  };
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const shown: unknown[] = [];
  let userId = 'bob';
  runInNewContext(
    await readFile(
      new URL('../../../apps/web/public/notification-sw.js', import.meta.url),
      'utf8',
    ),
    {
      self: {
        addEventListener: (
          name: string,
          handler: (event: WorkerEvent) => void,
        ) => handlers.set(name, handler),
        location: { origin: 'https://app.example.test' },
        registration: {
          showNotification: (title: string, options: unknown) =>
            shown.push({ title, options }),
        },
      },
      URL,
      Date,
      fetch: async () => ({
        ok: true,
        json: async () => ({ userId, notification }),
      }),
    },
  );
  const dispatch = async () => {
    let pending: Promise<void> | undefined;
    handlers.get('push')!({
      data: { json: () => ({ id: notification.id, userId: 'alice' }) },
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;
  };
  await dispatch();
  assert.equal(shown.length, 0);
  userId = 'alice';
  await dispatch();
  assert.equal(shown.length, 1);
  const displayed = shown[0] as { title: string; options: { body: string } };
  assert.equal(displayed.title, input.title);
  assert.equal(displayed.options.body, input.body);
  await service.close();
});

test('index hints use point simulation while existing instruments keep their execution model', async () => {
  const created: Record<string, unknown>[] = [];
  let wakeups = 0;
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'admin');
    c.set('isAdmin', true);
    await next();
  });
  app.route(
    '/strategies',
    signalRoutes(
      () =>
        ({
          config: { engine: 'tdx' },
          state: {
            instrument: async (_engine: string, symbol: string) =>
              symbol === 'missing'
                ? null
                : {
                    symbol,
                    kind: symbol === 'option' ? 'option' : 'stock',
                    expired: symbol === 'expired',
                  },
          },
          records: {
            storedStrategy: async () => ({ enabled: true, status: 'active' }),
            version: async () => ({
              strategy_id: 's1',
              number: 3,
              parameters: { lookback: 19 },
            }),
          },
          monitors: {
            create: async (
              _owner: string,
              _id: string,
              _version: number,
              _engine: string,
              config: Record<string, unknown>,
            ) => {
              created.push(config);
              return { id: 'm1', config };
            },
          },
          wake: () => {
            wakeups++;
          },
        }) as unknown as ReturnType<Parameters<typeof signalRoutes>[0]>,
    ),
  );
  const request = (symbol: string, extra = {}) =>
    app.request('/strategies/s1/monitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version_id: randomUUID(),
        symbol,
        duration: 60,
        ...extra,
      }),
    });
  for (const symbol of ['SSE.000852', 'SZSE.399006']) {
    const response = await request(symbol);
    assert.equal(response.status, 201, await response.text());
    const config = created.at(-1)!;
    assert.equal(config.execution_model, 'points');
    assert.deepEqual(config.parameters, { lookback: 19 });
    assert.equal(config.initial_cash, 1);
    assert.equal((config.rules as { lot_size: number }).lot_size, 1);
    assert.equal((config.rules as { t_plus_one: boolean }).t_plus_one, false);
  }
  assert.equal((await request('SSE.600000')).status, 201);
  assert.equal(
    monitorExecutionModel(created.at(-1)! as { symbol: string }),
    'actual_contract',
  );
  assert.equal(
    monitorExecutionModel({ symbol: 'KQ.m@CFFEX.IM' }),
    'continuous_price',
  );
  for (const symbol of ['missing', 'option', 'expired'])
    assert.equal((await request(symbol)).status, 400);
  assert.equal(
    (await request('SSE.000852', { execution_model: 'actual_contract' }))
      .status,
    400,
  );
  assert.equal(
    (await request('SSE.000852', { execution_model: 'continuous_price' }))
      .status,
    400,
  );
  assert.equal(wakeups, 3);
});

test('point history reads stored index prices without contract Tick reconstruction', async () => {
  let bounds: { rebuildTicks?: boolean } = {};
  const api = strategyDataRoutes(
    () =>
      ({
        config: { engine: 'tdx' },
        state: {
          instrument: async () => ({ symbol: 'SSE.000852', kind: 'stock' }),
        },
        store: {
          bars: async (
            _engine: string,
            _symbol: string,
            _duration: number,
            query: typeof bounds,
          ) => {
            bounds = query;
            return [];
          },
        },
      }) as unknown as ReturnType<Parameters<typeof strategyDataRoutes>[0]>,
  );
  const response = await api.request(
    '/history?symbol=SSE.000852&duration=60&after=1&before=1000&execution_model=points',
  );
  assert.equal(response.status, 200, await response.text());
  assert.equal(bounds.rebuildTicks, false);
});
