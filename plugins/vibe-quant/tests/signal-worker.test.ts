import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { PluginContext } from '@app/plugin-sdk/server';
import type { SyncStatus } from '../shared.js';
import { MonitorStore, type StoredMonitor } from '../server/signals/store.js';
import type { QuantConfig } from '../server/config.js';
import type { SignalMonitorInput } from '../signal-types.js';
import {
  SignalServiceScope1793318400000,
  signalServiceId,
} from '../server/signals/service-scope.js';
import type {
  StoredStrategy,
  StrategyStore,
} from '../server/strategies/store.js';
import { StrategyError } from '../server/strategies/schema.js';
import { SignalWorker } from '../server/signals/worker.js';

type User = { id: string; role: string | null; banned: boolean | null };
type Run = {
  abort: AbortController;
  promise: Promise<void>;
  status: string;
  message: string;
};

function fixture(serviceId?: string) {
  const monitor = {
    id: 'monitor',
    user_id: 'alice',
    strategy_id: 'strategy',
    service_id: serviceId,
    enabled: true,
    deleted: false,
    revision: 1,
    engine: 'tqsdk',
    config: { simulation_engine: 'builtin' },
  } as StoredMonitor;
  const rows = new Map([[monitor.id, monitor]]);
  const strategy = { id: 'strategy', enabled: true } as StoredStrategy;
  let missingStrategy = false;
  let runtime:
    | { owner: string; active: boolean; status: string; message: string }
    | undefined;
  const workers: SignalWorker[] = [];
  function service(id: string, users: User[] = []) {
    const localUsers = new Map(users.map((user) => [user.id, user]));
    const acquired: string[] = [],
      started: string[] = [],
      checkedUsers: string[] = [];
    let afterAcquire: (() => void) | undefined;
    const monitors = {
      serviceId: id,
      cleanupDeleted: async () => {},
      list: async () =>
        [...rows.values()]
          .filter((row) => !row.deleted)
          .map((row) => ({ ...row })),
      get: async (key: string) => {
        const row = rows.get(key);
        if (!row) throw new StrategyError('MONITOR_NOT_FOUND', 404);
        return { ...row };
      },
      bindService: async (row: StoredMonitor) => {
        const latest = rows.get(row.id)!;
        if (latest.service_id || latest.revision !== row.revision)
          return undefined;
        const next = { ...latest, service_id: id, revision: row.revision + 1 };
        rows.set(row.id, next);
        return next;
      },
      acquire: async (key: string, owner: string) => {
        acquired.push(key);
        if (rows.get(key)?.service_id !== id || runtime?.active) return false;
        runtime = {
          owner,
          active: true,
          status: 'starting',
          message: '正在准备实时计算',
        };
        afterAcquire?.();
        return true;
      },
      heartbeat: async (
        _key: string,
        owner: string,
        status: string,
        message: string,
        _checkpoint?: string,
        release = false,
      ) => {
        if (!runtime?.active || runtime.owner !== owner) return false;
        runtime = { owner, active: !release, status, message };
        return true;
      },
    } as unknown as MonitorStore;
    const context = {
      assertEnabled: async () => {},
      database: {
        query: async (_sql: string, [owner]: string[]) => {
          checkedUsers.push(owner);
          const user = localUsers.get(owner);
          return user ? [{ ...user }] : [];
        },
      },
    } as unknown as PluginContext;
    const worker = new SignalWorker(
      context,
      monitors,
      {
        storedStrategy: async () => {
          if (missingStrategy)
            throw new StrategyError('STRATEGY_NOT_FOUND', 404);
          return { ...strategy };
        },
      } as unknown as StrategyStore,
      async () => {
        throw new Error('Unexpected market request');
      },
      () => ({ engine: 'tqsdk', state: 'syncing' }) as SyncStatus,
    );
    const control = worker as unknown as {
      stopped: boolean;
      tick(): Promise<void>;
      current: Map<string, Run>;
      execute(row: StoredMonitor, run: Run): Promise<void>;
    };
    control.stopped = false;
    // Exercise the real scheduler, validation, lease handling and final status;
    // Python execution is covered separately by signal-monitor.test.ts.
    control.execute = async (row, run) => {
      started.push(row.id);
      run.status = 'running';
      run.message = '监听中';
      await new Promise<void>((_resolve, reject) => {
        run.abort.signal.addEventListener(
          'abort',
          () => reject(new Error('用户中止了操作')),
          { once: true },
        );
      });
    };
    const value = {
      worker,
      localUsers,
      acquired,
      started,
      checkedUsers,
      onAcquire(callback: () => void) {
        afterAcquire = callback;
      },
      async tick() {
        await control.tick();
        await Promise.allSettled(
          [...control.current.values()]
            .filter((run) => run.abort.signal.aborted)
            .map((run) => run.promise),
        );
      },
    };
    workers.push(worker);
    return value;
  }
  return {
    rows,
    strategy,
    service,
    runtime: () => runtime,
    removeStrategy: () => {
      missingStrategy = true;
    },
    stop: () => Promise.all(workers.map((worker) => worker.stop())),
  };
}

const admin = (): User => ({ id: 'alice', role: 'admin', banned: false });

test('a host without the legacy owner never acquires or changes its shared runtime', async (t) => {
  const f = fixture();
  t.after(f.stop);
  const foreign = f.service('foreign');
  await foreign.tick();
  assert.deepEqual(foreign.acquired, []);
  assert.equal(f.runtime(), undefined);
  assert.equal(f.rows.get('monitor')?.service_id, undefined);

  const owner = f.service('owner', [admin()]);
  await owner.tick();
  await owner.tick();
  assert.equal(f.rows.get('monitor')?.service_id, 'owner');
  assert.deepEqual(owner.started, ['monitor']);
  const before = f.runtime();
  await foreign.tick();
  assert.deepEqual(foreign.acquired, []);
  assert.deepEqual(f.runtime(), before);
});

test('equal user IDs in different databases do not share execution authority', async (t) => {
  const f = fixture('owner');
  t.after(f.stop);
  const foreign = f.service('foreign', [
    { ...admin(), banned: true, role: 'user' },
  ]);
  const owner = f.service('owner', [admin()]);
  await Promise.all([foreign.tick(), owner.tick()]);
  assert.deepEqual(foreign.checkedUsers, []);
  assert.deepEqual(foreign.acquired, []);
  assert.deepEqual(owner.started, ['monitor']);
  await owner.worker.stop();
  const restarted = f.service('owner', [admin()]);
  await restarted.tick();
  assert.deepEqual(restarted.started, ['monitor']);
});

test('replicas sharing a service identity still have only one lease holder', async (t) => {
  const f = fixture('owner');
  t.after(f.stop);
  const a = f.service('owner', [admin()]),
    b = f.service('owner', [admin()]);
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(a.started.length + b.started.length, 1);
});

const invalidCases = [
  ['disabled', '策略已停用，请先在策略管理中启用'],
  ['archived', '策略已归档，请先取消归档'],
  ['deleted', '策略已删除，请先恢复策略'],
  ['missing-strategy', '策略不存在，无法继续计算'],
  ['missing-user', '加载该策略的账号已被删除'],
  ['banned', '加载该策略的账号已被封禁'],
  ['role', '加载该策略的账号已无管理员权限，无法运行策略'],
] as const;
for (const [kind, message] of invalidCases) {
  for (const running of [false, true]) {
    test(`${running ? 'running' : 'starting'} monitor reports the specific ${kind} reason`, async (t) => {
      const f = fixture('owner');
      t.after(f.stop);
      const owner = f.service('owner', [admin()]);
      if (running) await owner.tick();
      if (kind === 'disabled') f.strategy.enabled = false;
      else if (kind === 'archived' || kind === 'deleted')
        f.strategy.status = kind;
      else if (kind === 'missing-strategy') f.removeStrategy();
      else if (kind === 'missing-user') owner.localUsers.delete('alice');
      else if (kind === 'banned') owner.localUsers.get('alice')!.banned = true;
      else owner.localUsers.get('alice')!.role = 'user';
      await owner.tick();
      assert.equal(f.runtime()?.status, 'paused');
      assert.equal(f.runtime()?.active, false);
      assert.equal(f.runtime()?.message, message);
      assert.equal(owner.started.length, running ? 1 : 0);
    });
  }
}

test('permission is rechecked after acquiring the lease', async (t) => {
  const f = fixture('owner');
  t.after(f.stop);
  const owner = f.service('owner', [admin()]);
  owner.onAcquire(() => {
    owner.localUsers.get('alice')!.role = 'user';
  });
  await owner.tick();
  assert.deepEqual(owner.started, []);
  assert.equal(
    f.runtime()?.message,
    '加载该策略的账号已无管理员权限，无法运行策略',
  );
  assert.equal(f.runtime()?.active, false);
});

for (const deleted of [false, true]) {
  test(`monitor ${deleted ? 'removal' : 'pause'} keeps its reason through process shutdown`, async (t) => {
    const f = fixture('owner');
    t.after(f.stop);
    const owner = f.service('owner', [admin()]);
    await owner.tick();
    if (deleted) f.rows.get('monitor')!.deleted = true;
    else f.rows.get('monitor')!.enabled = false;
    await owner.tick();
    assert.equal(
      f.runtime()?.message,
      deleted ? '该策略监听已移除' : '该策略监听已暂停，请开启计算开关',
    );
  });
}

test(
  'real ClickHouse: service-scoped leases and atomic legacy adoption preserve configuration',
  {
    skip: process.env.QUANT_SIGNAL_INTEGRATION !== '1',
    timeout: 60000,
  },
  async () => {
    const database = `signal_scope_test_${randomUUID().replaceAll('-', '')}`;
    const config = {
      clickhouseUrl: 'http://127.0.0.1:18124',
      clickhouseDatabase: database,
      clickhouseUser: 'test',
      clickhousePassword: 'test-only-local',
    } as QuantConfig;
    const a = new MonitorStore(config, 'service-a'),
      b = new MonitorStore(config, 'service-b');
    await a.request(`CREATE DATABASE ${database}`);
    try {
      await a.initialize();
      const created = await a.create(
        'alice',
        'strategy',
        1,
        'tqsdk',
        {
          symbol: 'SSE.000852',
          execution_model: 'points',
          simulation_engine: 'builtin',
        } as SignalMonitorInput,
        { notifications_enabled: false },
      );
      const stored = await a.get(created.id);
      assert.equal(stored.service_id, 'service-a');
      assert.equal(await b.bindService(stored), undefined);
      assert.equal(await b.acquire(created.id, 'foreign'), false);
      assert.equal(
        await a.runtime(created.id),
        undefined,
        'foreign host must not create a runtime record',
      );
      assert.equal(await a.acquire(created.id, 'first'), true);
      const replica = new MonitorStore(config, 'service-a');
      assert.equal(await replica.acquire(created.id, 'replica'), false);
      assert.equal(
        await a.heartbeat(
          created.id,
          'first',
          'paused',
          '服务已停止',
          undefined,
          true,
        ),
        true,
      );
      assert.equal(await replica.acquire(created.id, 'restarted'), true);
      assert.equal(
        await a.heartbeat(
          created.id,
          'first',
          'paused',
          'stale reason',
          undefined,
          true,
        ),
        false,
      );

      const legacy = {
        ...stored,
        id: randomUUID(),
        service_id: undefined,
        revision: 1,
      };
      await a.execute(
        `INSERT INTO ${a.table('quant_signal_monitors')} FORMAT JSONEachRow`,
        {},
        JSON.stringify({
          id: legacy.id,
          userId: legacy.user_id,
          payload: JSON.stringify(legacy),
          revision: 1,
        }),
      );
      assert.equal(await a.acquire(legacy.id, 'unbound'), false);
      const [boundA, boundB] = await Promise.all([
        a.bindService(legacy),
        b.bindService(legacy),
      ]);
      assert.equal(
        [boundA, boundB].filter(Boolean).length,
        1,
        'only one service may bind a legacy revision',
      );
      const winner = boundA ? a : b,
        loser = boundA ? b : a;
      const bound = await winner.get(legacy.id);
      assert.equal(bound.service_id, winner.serviceId);
      assert.equal(bound.revision, 2);
      assert.deepEqual(bound.config, legacy.config);
      assert.equal(bound.notifications_enabled, false);
      assert.equal(
        await loser.bindService(legacy),
        undefined,
        'a stale unbound snapshot cannot replace a binding',
      );
      assert.equal(await loser.acquire(legacy.id, 'loser'), false);
      assert.equal(await winner.acquire(legacy.id, 'winner'), true);

      const editedLegacy = { ...legacy, id: randomUUID() };
      await a.execute(
        `INSERT INTO ${a.table('quant_signal_monitors')} FORMAT JSONEachRow`,
        {},
        JSON.stringify({
          id: editedLegacy.id,
          userId: 'alice',
          payload: JSON.stringify(editedLegacy),
          revision: 1,
        }),
      );
      await a.update('alice', editedLegacy.id, 1, false);
      assert.equal(
        await a.bindService(editedLegacy),
        undefined,
        'adoption must not overwrite a concurrent user edit',
      );
      assert.equal((await a.get(editedLegacy.id)).enabled, false);
    } finally {
      await a.request(`DROP DATABASE ${database} SYNC`);
    }
  },
);

test(
  'real PostgreSQL: service identity survives reconnects and differs between user databases',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30000,
  },
  async () => {
    const adminDb = await new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
    }).initialize();
    const schemas = [0, 1].map(
      () => `signal_scope_test_${randomUUID().replaceAll('-', '')}`,
    );
    const connections: DataSource[] = [];
    try {
      const identities: string[] = [];
      for (const schema of schemas) {
        await adminDb.query(`CREATE SCHEMA ${schema}`);
        const db = await new DataSource({
          type: 'postgres',
          url: process.env.TEST_DATABASE_URL,
          extra: { options: `-c search_path=${schema}` },
        }).initialize();
        connections.push(db);
        const runner = db.createQueryRunner();
        try {
          await new SignalServiceScope1793318400000().up(runner);
        } finally {
          await runner.release();
        }
        const id = await signalServiceId(db);
        identities.push(id);
        await db.destroy();
        await db.initialize();
        assert.equal(await signalServiceId(db), id);
      }
      assert.notEqual(identities[0], identities[1]);
    } finally {
      await Promise.all(
        connections.filter((db) => db.isInitialized).map((db) => db.destroy()),
      );
      for (const schema of schemas)
        await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminDb.destroy();
    }
  },
);
