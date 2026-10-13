import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import type { Pool } from 'pg';
import { createAuthOptions, type Auth } from '@aime/auth';
import { Setting } from '@aime/db';
import { systemSettingsSchema } from '@aime/shared/system-settings';
import { createApp } from '../apps/server/src/app.js';
import { SystemSettingsService } from '../apps/server/src/modules/system-settings/service.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';

const origin = 'http://localhost:5173';

function memorySettings() {
  const rows = new Map<string, { id: string; value: unknown }>();
  const database = {
    manager: {
      async findOneBy(entity: unknown, { id }: { id: string }) {
        assert.equal(entity, Setting);
        return rows.get(id) ?? null;
      },
      async upsert(
        entity: unknown,
        row: { id: string; value: unknown },
        keys: string[],
      ) {
        assert.equal(entity, Setting);
        assert.deepEqual(keys, ['id']);
        rows.set(row.id, structuredClone(row));
      },
    },
  } as unknown as DataSource;
  return { service: new SystemSettingsService(database), database, rows };
}

function appFor(auth: Auth, service: SystemSettingsService) {
  return createApp(
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
}

test('registration defaults stay enabled and saved switches survive service recreation', async () => {
  const { service, database, rows } = memorySettings();
  assert.deepEqual(await service.get(), { registrationEnabled: true });
  assert.equal(rows.size, 0);
  await service.update({ registrationEnabled: false });
  assert.deepEqual(await new SystemSettingsService(database).get(), {
    registrationEnabled: false,
  });
  await service.update({ registrationEnabled: true });
  assert.equal(rows.size, 1);
  assert.deepEqual(await service.get(), { registrationEnabled: true });
  for (const value of [
    {},
    { registrationEnabled: 'false' },
    { registrationEnabled: null },
    { registrationEnabled: false, role: 'admin' },
  ]) {
    assert.equal(systemSettingsSchema.safeParse(value).success, false);
  }
});

test('system settings HTTP and RPC require an administrator, valid booleans and a trusted origin', async (t) => {
  let user: { id: string; role: string } | undefined;
  let requestOrigin: string | undefined = origin;
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as unknown as Auth;
  const { service, rows } = memorySettings();
  const app = appFor(auth, service);
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    if (requestOrigin) headers.set('Origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });

  for (const role of [undefined, 'user', 'admin-assistant']) {
    user = role ? { id: 'tester', role } : undefined;
    for (const call of [
      () => client.systemSettings.get(),
      () =>
        client.systemSettings.update({ body: { registrationEnabled: false } }),
    ]) {
      await assert.rejects(call(), {
        code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
      });
    }
    assert.equal(
      (await app.request('/api/admin/settings')).status,
      role ? 403 : 401,
    );
    assert.equal(
      (
        await app.request('/api/admin/settings', {
          method: 'PATCH',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ registrationEnabled: false }),
        })
      ).status,
      role ? 403 : 401,
    );
    const publicStatus = await app.request('/api/auth/registration-status');
    assert.equal(publicStatus.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await publicStatus.json(), { registrationEnabled: true });
  }
  assert.equal(rows.size, 0);

  user = { id: 'administrator', role: 'user,admin' };
  for (const badOrigin of [undefined, 'https://other.example']) {
    requestOrigin = badOrigin;
    await assert.rejects(
      client.systemSettings.update({ body: { registrationEnabled: false } }),
      { code: 'FORBIDDEN' },
    );
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (badOrigin) headers.set('Origin', badOrigin);
    assert.equal(
      (
        await app.request('/api/admin/settings', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ registrationEnabled: false }),
        })
      ).status,
      403,
    );
  }
  assert.equal(rows.size, 0);
  requestOrigin = origin;
  for (const body of [
    {},
    { registrationEnabled: 'false' },
    { registrationEnabled: null },
    { registrationEnabled: false, other: true },
  ]) {
    const response = await app.request('/api/admin/settings', {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(rows.size, 0);
  assert.deepEqual(await client.systemSettings.get(), {
    registrationEnabled: true,
  });
  assert.deepEqual(
    await client.systemSettings.update({
      body: { registrationEnabled: false },
    }),
    { registrationEnabled: false },
  );
  const status = await app.request('/api/auth/registration-status');
  assert.deepEqual(await status.json(), { registrationEnabled: false });
  assert.equal(
    (await app.request('/api/admin/settings')).headers.get('cache-control'),
    'no-store',
  );
  assert.equal(
    (
      await app.request(
        '/api/rpc/systemSettings/update?data=' +
          encodeURIComponent(
            JSON.stringify({ json: { body: { registrationEnabled: true } } }),
          ),
      )
    ).status,
    405,
  );
  const response = await app.request('/api/admin/settings', {
    method: 'PATCH',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationEnabled: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await client.systemSettings.get(), {
    registrationEnabled: true,
  });
});

test('Better Auth blocks closed public registration immediately, while sign-in and admin account creation remain available', async (t) => {
  const require = createRequire(
    new URL('../packages/auth/package.json', import.meta.url),
  );
  const { betterAuth } = await import(
    pathToFileURL(require.resolve('better-auth')).href
  );
  const { memoryAdapter } = await import(
    pathToFileURL(require.resolve('better-auth/adapters/memory')).href
  );
  const { service } = memorySettings();
  const data = { users: [], sessions: [], accounts: [], verifications: [] };
  const auth = betterAuth({
    ...createAuthOptions({
      pool: {} as Pool,
      secret: 'registration-test-secret-with-at-least-32-characters',
      webOrigin: origin,
      admins: 'admin',
      isRegistrationEnabled: async () =>
        (await service.get()).registrationEnabled,
    }),
    database: memoryAdapter(data),
    logger: { level: 'error' },
    rateLimit: { enabled: false },
  }) as Auth;
  const app = appFor(auth, service);
  const password = 'Registration-Test-Password-73!';
  const body = (username: string) => ({
    username,
    name: username,
    email: `${username}@example.com`,
    password,
  });
  async function post(path: string, input: unknown, cookie = '') {
    return app.request(`${origin}/api/auth/${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(input),
    });
  }
  const opened = await post('sign-up/email', body('existing'));
  assert.equal(opened.status, 200);
  const sessionCookie = opened.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(sessionCookie);
  assert.equal(data.users.length, 1);

  await service.update({ registrationEnabled: false });
  const closed = await post('sign-up/email', body('blocked'));
  assert.equal(closed.status, 403);
  assert.equal((await closed.json()).code, 'SIGNUP_DISABLED');
  assert.equal(closed.headers.get('set-cookie'), null);
  for (const path of ['sign-up/email/', 'sign-up/email?callbackURL=%2F']) {
    const variant = await post(path, body('variant'));
    assert.ok(
      [403, 404].includes(variant.status),
      `${path}: ${variant.status}`,
    );
  }
  await assert.rejects(auth.api.signUpEmail({ body: body('direct') }), {
    status: 'FORBIDDEN',
    body: { code: 'SIGNUP_DISABLED', message: '暂未开放注册，请联系管理员' },
  });
  assert.equal(data.users.length, 1);
  assert.equal(
    (await post('sign-in/username', { username: 'existing', password })).status,
    200,
  );
  assert.equal(
    (await post('sign-in/email', { email: 'existing@example.com', password }))
      .status,
    200,
  );
  assert.equal(
    (
      await app.request(`${origin}/api/me`, {
        headers: { cookie: sessionCookie },
      })
    ).status,
    200,
  );

  await auth.api.createUser({
    body: {
      name: 'admin',
      email: 'admin@example.com',
      password,
      role: 'admin',
      data: { username: 'admin' },
    },
  });
  const adminLogin = await post('sign-in/username', {
    username: 'admin',
    password,
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const managed = await post(
    'admin/create-user',
    {
      name: 'managed',
      email: 'managed@example.com',
      password,
      role: 'user',
      data: { username: 'managed' },
    },
    adminCookie,
  );
  assert.equal(managed.status, 200);
  assert.equal(
    (await post('sign-in/username', { username: 'managed', password })).status,
    200,
  );
  assert.equal(data.users.length, 3);

  await service.update({ registrationEnabled: true });
  assert.equal((await post('sign-up/email', body('reopened'))).status, 200);
  assert.equal(data.users.length, 4);
  const reserved = await post('sign-up/email', body('ADMIN'));
  assert.equal(reserved.status, 400);
  assert.equal((await reserved.json()).code, 'USERNAME_RESERVED');
  t.mock.method(service, 'get', async () => {
    throw new Error('Settings database unavailable');
  });
  assert.equal((await post('sign-up/email', body('unavailable'))).status, 500);
  assert.equal(data.users.length, 4);
});
