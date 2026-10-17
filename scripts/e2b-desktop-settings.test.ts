import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { DataSource } from 'typeorm';
import type { Auth } from '@aime/auth';
import { createDataSource, Setting } from '@aime/db';
import {
  defaultSystemSettings,
  systemSettingsUpdateSchema,
  type SystemSettings,
} from '@aime/shared/system-settings';
import {
  SystemSettingsService,
  type E2BDesktopDeployment,
} from '../apps/server/src/modules/system-settings/service.js';
import { createApp } from '../apps/server/src/app.js';
import { E2BDesktopService } from '../apps/server/src/modules/e2b-desktop/service.js';

function fixture(initial?: unknown, deployment?: E2BDesktopDeployment) {
  let value = initial;
  const updates: SystemSettings[] = [];
  const database = {
    manager: {
      async findOneBy(entity: unknown, { id }: { id: string }) {
        assert.equal(entity, Setting);
        assert.equal(id, 'system:settings');
        return value === undefined
          ? null
          : { id, value: structuredClone(value) };
      },
      async upsert(entity: unknown, row: { id: string; value: unknown }) {
        assert.equal(entity, Setting);
        assert.equal(row.id, 'system:settings');
        value = structuredClone(row.value);
      },
    },
  } as unknown as DataSource;
  const service = new SystemSettingsService(
    database,
    (value) => updates.push(value),
    deployment,
  );
  return { service, database, updates, stored: () => value };
}

const desktop = {
  e2bDesktopEnabled: true,
  e2bDesktopApiUrl: 'http://e2b.test:3000',
  e2bDesktopApiKey: 'test-only-api-key',
};

test(
  'PostgreSQL persists desktop settings in the existing settings table',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = `desktop_settings_${randomBytes(8).toString('hex')}`;
    const pool = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      entities: [Setting],
      migrations: [],
    });
    let created = false;
    t.after(async () => {
      try {
        if (database.isInitialized) await database.destroy();
      } finally {
        try {
          if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      }
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await pool.query(
      `CREATE TABLE "${schema}".settings (id text PRIMARY KEY, value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`,
    );
    await database.initialize();
    const service = new SystemSettingsService(database);
    await service.update(desktop);
    await service.update({ requestLoggingEnabled: false });
    const saved = await new SystemSettingsService(database).get();
    assert.equal(saved.e2bDesktopApiUrl, desktop.e2bDesktopApiUrl);
    assert.equal(saved.e2bDesktopHasApiKey, true);
    assert.equal('e2bDesktopApiKey' in saved, false);
    const managed = new SystemSettingsService(database, undefined, {
      apiUrl: 'http://host.docker.internal:3000',
      apiKey: 'deployment-only-secret',
      template: 'desktop',
      timeoutSeconds: 300,
    });
    const managedSaved = await managed.update({ registrationEnabled: false });
    assert.equal(managedSaved.e2bDesktopManaged, true);
    const persisted = await database.manager.findOneByOrFail(Setting, {
      id: 'system:settings',
    });
    assert.equal(
      JSON.stringify(persisted.value).includes('deployment-only-secret'),
      false,
    );
    assert.equal(
      (await new SystemSettingsService(database).get()).e2bDesktopApiUrl,
      desktop.e2bDesktopApiUrl,
    );
    await service.update({ e2bDesktopEnabled: false, e2bDesktopApiKey: null });
    assert.equal(
      (await new SystemSettingsService(database).get()).e2bDesktopHasApiKey,
      false,
    );
  },
);

test('new and legacy settings receive disabled desktop defaults', async () => {
  assert.deepEqual(await fixture().service.get(), defaultSystemSettings);
  assert.deepEqual(
    await fixture({ registrationEnabled: false }).service.get(),
    {
      ...defaultSystemSettings,
      registrationEnabled: false,
    },
  );
});

test('desktop credentials persist without leaking into read, update or callback results', async () => {
  const { service, database, stored, updates } = fixture();
  const saved = await service.update(desktop);
  assert.equal(saved.e2bDesktopHasApiKey, true);
  assert.equal(saved.e2bDesktopEnabled, true);
  assert.equal(
    (stored() as Record<string, unknown>).e2bDesktopApiKey,
    desktop.e2bDesktopApiKey,
  );
  assert.deepEqual(await new SystemSettingsService(database).get(), saved);
  for (const value of [saved, await service.get(), ...updates]) {
    assert.equal('e2bDesktopApiKey' in value, false);
    assert.equal(
      JSON.stringify(value).includes(desktop.e2bDesktopApiKey),
      false,
    );
  }
});

test('blank and omitted API keys preserve the secret, null clears it, and replacement trims whitespace', async () => {
  const { service, stored } = fixture();
  await service.update(desktop);
  await service.update({ e2bDesktopApiUrl: 'https://e2b.example/api' });
  await service.update({ e2bDesktopApiKey: '' });
  assert.equal(
    (stored() as Record<string, unknown>).e2bDesktopApiKey,
    desktop.e2bDesktopApiKey,
  );
  await service.update({ e2bDesktopApiKey: ' space ' });
  assert.equal((stored() as Record<string, unknown>).e2bDesktopApiKey, 'space');
  const cleared = await service.update({
    e2bDesktopEnabled: false,
    e2bDesktopApiKey: null,
  });
  assert.equal(cleared.e2bDesktopHasApiKey, false);
  assert.equal((stored() as Record<string, unknown>).e2bDesktopApiKey, null);
});

test('concurrent independent settings updates preserve desktop credentials and flags', async () => {
  const { service, stored } = fixture();
  await service.update(desktop);
  await Promise.all([
    service.update({ registrationEnabled: false }),
    service.update({ requestLoggingEnabled: false }),
    service.update({ e2bDesktopApiUrl: 'https://e2b.example/api' }),
  ]);
  assert.deepEqual(await service.get(), {
    registrationEnabled: false,
    requestLoggingEnabled: false,
    e2bDesktopEnabled: true,
    e2bDesktopApiUrl: 'https://e2b.example/api',
    e2bDesktopHasApiKey: true,
    e2bDesktopManaged: false,
    e2bDesktopTemplate: 'desktop',
    e2bDesktopTimeoutSeconds: 300,
  });
  assert.equal(
    (stored() as Record<string, unknown>).e2bDesktopApiKey,
    desktop.e2bDesktopApiKey,
  );
});

test('deployment config takes effect immediately, survives unrelated saves, and never enters persisted or public settings', async () => {
  const deployment = {
    apiUrl: 'http://host.docker.internal:3000',
    apiKey: 'deployment-only-secret',
    template: 'local-desktop',
    timeoutSeconds: 900,
  };
  const original = {
    registrationEnabled: true,
    ...desktop,
    e2bDesktopEnabled: false,
  };
  const { service, database, updates, stored } = fixture(original, deployment);
  const settings = await service.get();
  assert.equal(settings.e2bDesktopManaged, true);
  assert.equal(settings.e2bDesktopEnabled, true);
  assert.equal(settings.e2bDesktopApiUrl, deployment.apiUrl);
  assert.equal(settings.e2bDesktopTemplate, deployment.template);
  assert.equal(settings.e2bDesktopTimeoutSeconds, deployment.timeoutSeconds);
  assert.equal(settings.e2bDesktopHasApiKey, true);
  assert.deepEqual(await service.getE2BDesktopConfig(), deployment);

  const manager = new E2BDesktopService(service, async (input, init) => {
    assert.equal(new URL(String(input)).origin, deployment.apiUrl);
    assert.equal(
      new Headers(init?.headers).get('X-API-Key'),
      deployment.apiKey,
    );
    return Response.json([]);
  });
  assert.deepEqual(await manager.test(), { ok: true });
  const updated = await service.update({ registrationEnabled: false });
  assert.equal(updated.e2bDesktopManaged, true);
  assert.equal(updated.registrationEnabled, false);
  const saved = stored() as Record<string, unknown>;
  assert.equal(saved.e2bDesktopApiKey, desktop.e2bDesktopApiKey);
  assert.equal(saved.e2bDesktopEnabled, false);
  assert.equal('e2bDesktopManaged' in saved, false);
  for (const result of [settings, updated, saved, ...updates])
    assert.equal(JSON.stringify(result).includes(deployment.apiKey), false);
  // Removing the deployment override restores the stored external connection.
  const external = await new SystemSettingsService(database).get();
  assert.equal(external.e2bDesktopApiUrl, desktop.e2bDesktopApiUrl);
  assert.equal(external.e2bDesktopManaged, false);
});

test('deployment-managed desktop config rejects API edits without blocking other settings', async () => {
  const { service, stored } = fixture(undefined, {
    apiUrl: 'http://host.docker.internal:3000',
    apiKey: 'deployment-only-secret',
    template: 'desktop',
    timeoutSeconds: 300,
  });
  for (const patch of [
    { e2bDesktopEnabled: false },
    { e2bDesktopApiUrl: 'http://other.test' },
    { e2bDesktopApiKey: null },
    { e2bDesktopApiKey: '' },
    { e2bDesktopTemplate: 'other', requestLoggingEnabled: false },
    { e2bDesktopTimeoutSeconds: 600 },
  ])
    await assert.rejects(service.update(patch), {
      code: 'E2B_MANAGED_CONFIG',
      status: 409,
    });
  assert.equal(stored(), undefined);
  assert.equal(
    systemSettingsUpdateSchema.safeParse({ e2bDesktopManaged: false }).success,
    false,
  );
  await service.update({ requestLoggingEnabled: false });
  assert.equal((await service.get()).requestLoggingEnabled, false);
  assert.equal((stored() as Record<string, unknown>).e2bDesktopApiKey, null);
});

test('desktop URLs reject unsafe schemes and embedded credentials; enabled entries require an address', async () => {
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/desktop',
    '/vnc.html',
    'https://user:secret@example.com',
  ])
    assert.equal(
      systemSettingsUpdateSchema.safeParse({ e2bDesktopApiUrl: url }).success,
      false,
    );
  assert.equal(
    systemSettingsUpdateSchema.safeParse({ e2bDesktopHasApiKey: true }).success,
    false,
  );
  const { service, stored } = fixture();
  await assert.rejects(service.update({ e2bDesktopEnabled: true }), {
    code: 'VALIDATION_ERROR',
  });
  assert.equal(stored(), undefined);
  await service.update({
    ...desktop,
    e2bDesktopEnabled: true,
    e2bDesktopApiUrl: ' https://e2b.example/api ',
  });
  assert.equal(
    (await service.get()).e2bDesktopApiUrl,
    'https://e2b.example/api',
  );
  await assert.rejects(service.update({ e2bDesktopApiUrl: '' }), {
    code: 'VALIDATION_ERROR',
  });
  await service.update({ e2bDesktopEnabled: false, e2bDesktopApiUrl: '' });
  assert.equal((await service.get()).e2bDesktopEnabled, false);
});

test('failed saves retain the prior configuration and allow later updates', async (t) => {
  const { service, database, updates } = fixture();
  await service.update(desktop);
  const before = await service.get();
  const mock = t.mock.method(database.manager, 'upsert', async () => {
    throw new Error('write failed');
  });
  await assert.rejects(
    service.update({ e2bDesktopApiKey: 'replacement-key' }),
    /write failed/,
  );
  assert.deepEqual(await service.get(), before);
  assert.equal(updates.length, 1);
  mock.mock.restore();
  assert.equal(
    (await service.update({ e2bDesktopEnabled: false })).e2bDesktopEnabled,
    false,
  );
});

test('desktop settings API enforces administrator and origin checks and never returns the API key', async () => {
  const { service, stored } = fixture();
  const origin = 'http://localhost:5173';
  let role: string | undefined;
  const auth = {
    api: {
      getSession: async () =>
        role ? { user: { id: 'settings-tester', role } } : null,
    },
  } as unknown as Auth;
  const app = createApp(
    auth,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { service, webOrigin: origin },
  );
  const update = (body: unknown, requestOrigin = origin) =>
    app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  for (role of [undefined, 'user']) {
    assert.equal((await update(desktop)).status, role ? 403 : 401);
    assert.equal(
      (await app.request('/api/admin/settings')).status,
      role ? 403 : 401,
    );
  }
  assert.equal(stored(), undefined);
  role = 'admin';
  assert.equal(
    (await update(desktop, 'https://untrusted.example')).status,
    403,
  );
  assert.equal((await update({ e2bDesktopEnabled: true })).status, 400);
  assert.equal(
    (await update({ e2bDesktopApiUrl: 'javascript:alert(1)' })).status,
    400,
  );
  const response = await update(desktop);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.e2bDesktopHasApiKey, true);
  assert.equal('e2bDesktopApiKey' in saved, false);
  const read = await app.request('/api/admin/settings');
  assert.deepEqual(await read.json(), saved);
});

test('management requires an enabled, complete config; connection testing works while disabled', async () => {
  const { service } = fixture();
  const manager = new E2BDesktopService(service, async () => Response.json([]));
  await assert.rejects(manager.test(), { code: 'E2B_NOT_CONFIGURED' });
  await assert.rejects(manager.list(), { code: 'E2B_DISABLED' });
  await service.update({ ...desktop, e2bDesktopEnabled: false });
  assert.deepEqual(await manager.test(), { ok: true });
  await assert.rejects(manager.create({ name: '' }), { code: 'E2B_DISABLED' });
});

function remoteFixture() {
  const sandbox = {
    sandboxID: 'sandbox-1',
    templateID: 'desktop-template',
    state: 'running',
    startedAt: '2026-10-17T00:00:00Z',
    endAt: '2026-10-17T00:05:00Z',
    cpuCount: 2,
    memoryMB: 512,
    metadata: {
      managedBy: 'desktop-admin',
      name: 'Test desktop',
      secret: 'hidden-metadata',
    },
    envdAccessToken: 'hidden-envd-token',
    trafficAccessToken: 'hidden-traffic-token',
  };
  const calls: Array<{ url: URL; method: string; body: unknown }> = [];
  let removed = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    assert.equal(
      new Headers(init?.headers).get('X-API-Key'),
      desktop.e2bDesktopApiKey,
    );
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (url.pathname === '/v2/sandboxes' && method === 'POST') {
      assert.deepEqual(body, {
        templateID: 'desktop',
        timeout: 300,
        metadata: { managedBy: 'desktop-admin', name: 'Test desktop' },
      });
      return Response.json(sandbox, { status: 201 });
    }
    if (url.pathname === '/v2/sandboxes') {
      if (url.searchParams.get('limit') !== '1')
        assert.equal(
          url.searchParams.get('metadata'),
          'managedBy=desktop-admin',
        );
      return Response.json(
        removed
          ? []
          : [
              sandbox,
              {
                ...sandbox,
                sandboxID: 'foreign',
                metadata: { name: 'Other app' },
              },
            ],
        { headers: { 'X-Next-Token': 'cursor-2' } },
      );
    }
    if (url.pathname === '/sandboxes/sandbox-1/timeout') {
      assert.equal(method, 'POST');
      assert.deepEqual(body, { timeout: 600 });
      sandbox.endAt = '2026-10-17T00:10:00Z';
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/sandboxes/sandbox-1' && method === 'DELETE') {
      removed = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/sandboxes/foreign')
      return Response.json({ ...sandbox, metadata: { name: 'Other app' } });
    if (url.pathname === '/sandboxes/sandbox-1') return Response.json(sandbox);
    throw new Error('Unexpected upstream request');
  };
  return { fetcher, calls };
}

test('desktop lifecycle uses official API fields, filters owned instances, pages, and masks upstream credentials', async () => {
  const { service } = fixture();
  await service.update(desktop);
  const remote = remoteFixture();
  const manager = new E2BDesktopService(service, remote.fetcher);
  assert.deepEqual(await manager.create({ name: 'Test desktop' }), {
    id: 'sandbox-1',
  });
  const list = await manager.list('cursor-1');
  assert.equal(
    remote.calls.at(-1)?.url.searchParams.get('nextToken'),
    'cursor-1',
  );
  assert.equal(list.nextToken, 'cursor-2');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, 'sandbox-1');
  assert.equal(JSON.stringify(list).includes('hidden-'), false);
  await manager.update('sandbox-1', 600);
  const updated = await manager.get('sandbox-1');
  assert.equal(updated.endAt, '2026-10-17T00:10:00Z');
  assert.equal(JSON.stringify(updated).includes('hidden-'), false);
  await manager.delete('sandbox-1');
  assert.deepEqual((await manager.list()).items, []);
  await assert.rejects(manager.update('foreign', 600), {
    code: 'E2B_NOT_MANAGED',
  });
  await assert.rejects(manager.delete('foreign'), { code: 'E2B_NOT_MANAGED' });
  assert.equal(
    remote.calls.some(
      (call) =>
        call.url.pathname === '/sandboxes/foreign' && call.method !== 'GET',
    ),
    false,
  );
});

test('management requests use fresh settings and keep a single connection snapshot through mutations', async () => {
  const { service } = fixture();
  await service.update(desktop);
  const endpoints: string[] = [];
  const remote = remoteFixture();
  const manager = new E2BDesktopService(service, async (input, init) => {
    endpoints.push(new URL(String(input)).host);
    if (init?.method === 'GET')
      await service.update({
        e2bDesktopApiUrl: 'http://replacement.test:3000',
      });
    return remote.fetcher(input, init);
  });
  await manager.delete('sandbox-1');
  assert.deepEqual(endpoints, ['e2b.test:3000', 'e2b.test:3000']);
  await manager.list();
  assert.equal(endpoints.at(-1), 'replacement.test:3000');
});

test('upstream failures are bounded and sanitized; malformed responses do not pass as success', async () => {
  const { service } = fixture();
  await service.update(desktop);
  for (const [status, code] of [
    [401, 'E2B_AUTH_FAILED'],
    [403, 'E2B_AUTH_FAILED'],
    [404, 'E2B_NOT_FOUND'],
    [429, 'E2B_RATE_LIMITED'],
    [500, 'E2B_REQUEST_FAILED'],
  ] as const) {
    const manager = new E2BDesktopService(
      service,
      async () => new Response('secret-upstream-body', { status }),
    );
    await assert.rejects(manager.test(), (error) => {
      assert.equal((error as { code: string }).code, code);
      assert.equal(String(error).includes('secret-upstream-body'), false);
      return true;
    });
  }
  await assert.rejects(
    new E2BDesktopService(
      service,
      async () => new Response('<html>noVNC</html>'),
    ).test(),
    { code: 'E2B_INVALID_RESPONSE' },
  );
  await assert.rejects(
    new E2BDesktopService(service, async () => {
      throw new Error('secret-request-url');
    }).test(),
    { code: 'E2B_UNAVAILABLE' },
  );
});

test('management REST endpoints enforce administrator/origin checks and complete CRUD through the service', async (t) => {
  const { service } = fixture();
  await service.update(desktop);
  const remote = remoteFixture();
  t.mock.method(globalThis, 'fetch', remote.fetcher);
  let role: string | undefined;
  const auth = {
    api: {
      getSession: async () => (role ? { user: { id: 'tester', role } } : null),
    },
  } as unknown as Auth;
  const origin = 'http://localhost:5173';
  const app = createApp(
    auth,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { service, webOrigin: origin },
  );
  const path = '/api/admin/settings/e2b-desktop';
  const request = (
    suffix: string,
    method = 'GET',
    body?: unknown,
    requestOrigin = origin,
  ) =>
    app.request(path + suffix, {
      method,
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  for (role of [undefined, 'user']) {
    for (const [suffix, method, body] of [
      ['/test', 'POST'],
      ['/sandboxes', 'GET'],
      ['/sandboxes', 'POST', { name: 'Test desktop' }],
      ['/sandboxes/sandbox-1', 'GET'],
      ['/sandboxes/sandbox-1', 'PATCH', { timeoutSeconds: 600 }],
      ['/sandboxes/sandbox-1', 'DELETE'],
    ] as const) {
      assert.equal(
        (await request(suffix, method, body)).status,
        role ? 403 : 401,
      );
    }
  }
  assert.equal(remote.calls.length, 0);
  role = 'admin';
  for (const [suffix, method] of [
    ['/test', 'POST'],
    ['/sandboxes', 'POST'],
    ['/sandboxes/sandbox-1', 'PATCH'],
    ['/sandboxes/sandbox-1', 'DELETE'],
  ]) {
    assert.equal(
      (await request(suffix, method, undefined, 'https://untrusted.example'))
        .status,
      403,
    );
  }
  assert.equal(
    (await request('/sandboxes', 'POST', { timeoutSeconds: -1 })).status,
    400,
  );
  assert.equal(
    (await request('/sandboxes/sandbox-1', 'PATCH', { template: 'other' }))
      .status,
    400,
  );
  assert.equal((await request('/test', 'POST')).status, 200);
  const created = await request('/sandboxes', 'POST', { name: 'Test desktop' });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { id: 'sandbox-1' });
  const list = await request('/sandboxes');
  assert.equal(list.status, 200);
  assert.equal((await list.json()).items.length, 1);
  assert.equal(
    (await request('/sandboxes/sandbox-1', 'PATCH', { timeoutSeconds: 600 }))
      .status,
    200,
  );
  const info = await request('/sandboxes/sandbox-1');
  assert.equal((await info.json()).endAt, '2026-10-17T00:10:00Z');
  assert.equal((await request('/sandboxes/sandbox-1', 'DELETE')).status, 200);
  assert.deepEqual((await (await request('/sandboxes')).json()).items, []);
});
