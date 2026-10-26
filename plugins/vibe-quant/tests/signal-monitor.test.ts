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
          parameters: { lookback: 42 },
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
});

for (const monitorSymbol of [actual, 'KQ.m@CFFEX.IM'])
  test(
    `real Python ${monitorSymbol}: warmup, entry/reversal/risk exits and checkpoint recovery`,
    { timeout: 45000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'signal-monitor-test-'));
      const sdk = fileURLToPath(new URL('../sdk', import.meta.url)),
        worker = fileURLToPath(
          new URL('../worker/strategy_monitor.py', import.meta.url),
        );
      const settings = config();
      settings.symbol = monitorSymbol;
      settings.calendar = { ...settings.calendar, '2026-10-18': false };
      const source = `from quant_sdk import Strategy
class Signals(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params['symbol'], 60)
    def on_bar(self, ctx, bar):
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
        volume: 10000,
      });
      const chartBar = (value: ReturnType<typeof bar>, symbol: string) => ({
        ...value,
        symbol,
        ...(symbol.startsWith('KQ.m@')
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
                  if (signals.length === 4) setTimeout(() => abort.abort(), 20);
                  return true;
                }
                const path = String(message.path);
                if (path.startsWith('/instruments/'))
                  return {
                    symbol: decodeURIComponent(path.split('/').at(-1)!),
                    kind: path.includes('KQ') ? 'continuous' : 'future',
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
                if (path === '/contracts')
                  return {
                    mappings: [{ time: start - 86400, underlying: actual }],
                    next: null,
                  };
                if (path === '/history')
                  return {
                    bars: (resume ? [...warmup, ...live] : warmup).map((bar) =>
                      chartBar(
                        bar,
                        (message.params as { symbol: string }).symbol,
                      ),
                    ),
                    next: null,
                  };
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
          [
            ['entry', 'long'],
            ['exit', 'long'],
            ['entry', 'short'],
            ['exit', 'short'],
          ],
        );
        assert.equal(new Set(signals.map((v) => v.id)).size, 4);
        assert.ok(checkpoint);
        assert.ok(
          overlays.some((overlay) =>
            overlay.levels.some(
              (level) =>
                level.stop_loss === 105 &&
                level.chart_stop_loss ===
                  (monitorSymbol === actual ? 105 : 125) &&
                level.chart_time === cutoff + 60,
            ),
          ),
        );
        assert.equal(
          overlays.at(-1)?.levels.length,
          0,
          'exit clears protection lines',
        );
        assert.equal(signals[0].chart_time, cutoff);
        assert.equal(signals[3].chart_time, cutoff + 120);
        await writeFile(
          join(directory, 'checkpoint.json'),
          JSON.stringify(checkpoint),
        );
        await execute(true);
        assert.equal(ready, 2);
        assert.equal(
          signals.length,
          4,
          'recovery never replays historical notifications',
        );
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
    const store = new MonitorStore({
      clickhouseUrl: 'http://127.0.0.1:18124',
      clickhouseDatabase: database,
      clickhouseUser: 'test',
      clickhousePassword: 'test-only-local',
    } as QuantConfig);
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
      await assert.rejects(
        records.runs('bob', strategy.id),
        /STRATEGY_NOT_FOUND/,
      );
      const row = await store.create('alice', 'strategy', 1, 'tqsdk', config());
      assert.equal(row.status, 'starting');
      assert.equal((await store.list('bob')).length, 0);
      await assert.rejects(store.get(row.id, 'bob'), /MONITOR_NOT_FOUND/);
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
        store.signal('alice', signal),
        store.signal('alice', signal),
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
