import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PluginContext, PluginHttpEnv } from '@app/plugin-sdk/server';
import {
  strategyNotifications,
  strategyNotificationsSchema,
} from '../strategy-notifications.js';
import { strategyRoutes } from '../server/strategies/routes.js';
import {
  StrategyStore,
  type StoredStrategy,
} from '../server/strategies/store.js';
import { StrategySources, sha256 } from '../server/strategies/sources.js';
import type { QuantConfig } from '../server/config.js';

// Exercise the real store and HTTP validation, replacing only database/source I/O.
class MemoryRecords extends StrategyStore {
  data = new Map<string, StoredStrategy>();
  scripts = new Map<string, string>();
  override get sources() {
    return {
      put: async (source: string) => {
        const hash = sha256(source);
        this.scripts.set(hash, source);
        return hash;
      },
      read: async (hash: string) => this.scripts.get(hash)!,
    } as StrategySources;
  }
  override async rows<T>(
    _query: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const row = this.data.get(params.id);
    if (!row || (params.owner && row.user_id !== params.owner)) return [];
    return [{ payload: JSON.stringify(row), revision: row.revision }] as T[];
  }
  override async execute(
    _query: string,
    params: Record<string, string> = {},
    body?: string,
  ) {
    const current = this.data.get(params.id);
    if ((current?.revision ?? 0) !== Number(params.previous))
      return { text: '', writtenRows: 0 };
    this.data.set(params.id, JSON.parse(JSON.parse(body!).payload));
    return { text: '', writtenRows: 1 };
  }
}

const body = {
  name: 'Notification preferences',
  description: '',
  enabled: true,
  draft: { source: 'class Example: pass', parameters: {} },
};
const configured = {
  channels: {
    toast: { enabled: true },
    desktop: { enabled: false, future_option: 'preserved' },
    future_channel: { enabled: true, options: { mode: 'digest' } },
  },
};
function fixture() {
  const records = new MemoryRecords({
    clickhouseDatabase: 'test',
  } as QuantConfig);
  const app = new Hono<PluginHttpEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('x-user') ?? 'alice');
    c.set('isAdmin', false);
    await next();
  });
  app.route(
    '/strategies',
    strategyRoutes(
      {} as PluginContext,
      () => records,
      () => {
        throw new Error('Saving preferences must not start market workers');
      },
    ),
  );
  const request = (
    path: string,
    method = 'GET',
    value?: unknown,
    user = 'alice',
  ) =>
    app.request(`/strategies${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-user': user },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  return { records, request };
}

test('notification channels default off and preserve future channel options', () => {
  assert.deepEqual(strategyNotifications(), {
    channels: { toast: { enabled: false }, desktop: { enabled: false } },
  });
  assert.deepEqual(strategyNotificationsSchema.parse(configured), configured);
  const first = strategyNotifications();
  first.channels.toast.enabled = true;
  assert.equal(strategyNotifications().channels.toast.enabled, false);
});

test('strategy HTTP saves persist preferences, omitted updates preserve them, explicit off survives reload', async () => {
  const { request, records } = fixture();
  const created = await request('', 'POST', {
    ...body,
    notifications: configured,
  });
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.deepEqual(saved.notifications, configured);
  assert.deepEqual(records.data.get(saved.id)?.notifications, configured);
  // Old clients and Agent tools omit this field when changing source or metadata.
  const changed = await request(`/${saved.id}`, 'PUT', {
    ...body,
    name: 'Renamed',
    revision: saved.revision,
  });
  assert.equal(changed.status, 200);
  const next = await changed.json();
  assert.deepEqual(next.notifications, configured);
  const disabled = structuredClone(configured);
  disabled.channels.toast.enabled = false;
  const updated = await request(`/${saved.id}`, 'PUT', {
    ...body,
    revision: next.revision,
    notifications: disabled,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(
    (await (await request(`/${saved.id}`)).json()).notifications,
    disabled,
  );
  const latest = await updated.json();
  await records.publish('alice', saved.id, latest.revision, 'fixed version');
  assert.deepEqual(
    (await records.detail('alice', saved.id)).notifications,
    disabled,
  );
});

test('legacy records read as disabled and retain preferences through lifecycle changes', async () => {
  const { request, records } = fixture();
  const saved = await records.save('alice', body);
  delete records.data.get(saved.id)!.notifications;
  assert.deepEqual(
    (await records.detail('alice', saved.id)).notifications,
    strategyNotifications(),
  );
  const updated = await records.save(
    'alice',
    { ...body, notifications: configured },
    saved.id,
    saved.revision,
  );
  const archived = await records.setStatus(
    'alice',
    saved.id,
    updated.revision,
    'archived',
  );
  await records.setStatus('alice', saved.id, archived.revision, 'active');
  assert.deepEqual(
    (await records.detail('alice', saved.id)).notifications,
    configured,
  );
  assert.equal(
    (
      await request(`/${saved.id}`, 'PUT', {
        ...body,
        revision: saved.revision,
        notifications: strategyNotifications(),
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(`/${saved.id}`, 'GET', undefined, 'bob')).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/${saved.id}`,
        'PUT',
        { ...body, revision: 4, notifications: strategyNotifications() },
        'bob',
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await records.detail('alice', saved.id)).notifications,
    strategyNotifications(),
  );
  assert.equal(records.data.get(saved.id)?.user_id, 'alice');
});

test('malformed preferences are rejected without replacing saved channels', async () => {
  const { request, records } = fixture();
  const saved = await records.save('alice', {
    ...body,
    notifications: configured,
  });
  for (const notifications of [
    null,
    [],
    {},
    { channels: [] },
    { channels: { toast: true } },
    { channels: { desktop: { enabled: 'true' } } },
  ]) {
    assert.equal(
      (
        await request(`/${saved.id}`, 'PUT', {
          ...body,
          revision: saved.revision,
          notifications,
        })
      ).status,
      400,
    );
  }
  assert.deepEqual(
    (await records.detail('alice', saved.id)).notifications,
    configured,
  );
  assert.equal(
    (await records.detail('alice', saved.id)).revision,
    saved.revision,
  );
});
