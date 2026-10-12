import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Pool } from 'pg';
import { createAuthOptions, type Auth } from '@aime/auth';
import { normalizeWebOrigins, webOriginsEnvSchema } from '@aime/shared';
import { loadEnv } from '@aime/shared/env';
import { createApp } from '../apps/server/src/app.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';
import type { ProviderService } from '../apps/server/src/modules/providers/service.js';

const localOrigin = 'http://127.0.0.1:5173';
const lanOrigin = 'http://192.168.1.13:5173';
const origins = [localOrigin, lanOrigin];
const rejectedOrigins = [
  undefined,
  'null',
  'https://untrusted.example',
  'http://192.168.1.13:5174',
  'http://192.168.1.13.evil.example:5173',
];

test('web origins support explicit lists, reject unsafe entries and preserve the primary origin', (t) => {
  assert.deepEqual(
    normalizeWebOrigins(
      webOriginsEnvSchema.parse(
        ` ${localOrigin}/, ${lanOrigin}, ${localOrigin}, `,
      ),
    ),
    origins,
  );
  assert.deepEqual(normalizeWebOrigins(localOrigin), [localOrigin]);
  assert.deepEqual(webOriginsEnvSchema.parse(undefined), []);
  for (const value of [
    '*',
    'http://*.example.com',
    'file:///tmp',
    'http://user:password@example.com',
    `${localOrigin}/projects`,
    `${localOrigin}?query=1`,
    `${localOrigin}#fragment`,
  ]) {
    assert.equal(webOriginsEnvSchema.safeParse(value).success, false, value);
  }

  const overrides = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    BETTER_AUTH_SECRET: 'origin-test-secret-with-at-least-32-characters',
    BETTER_AUTH_URL: localOrigin,
    WEB_ORIGIN: localOrigin,
    WEB_ORIGINS: lanOrigin,
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, overrides);
  assert.deepEqual(loadEnv().WEB_ORIGINS, origins);
  delete process.env.WEB_ORIGINS;
  assert.deepEqual(loadEnv().WEB_ORIGINS, [localOrigin]);
  process.env.WEB_ORIGINS = 'http://*.example.com';
  assert.throws(loadEnv, /WEB_ORIGINS/);

  process.env.NODE_ENV = 'production';
  process.env.BETTER_AUTH_URL = 'https://app.example.com';
  process.env.WEB_ORIGIN = 'https://app.example.com';
  process.env.WEB_ORIGINS = lanOrigin;
  assert.throws(loadEnv, /HTTPS/);
  process.env.WEB_ORIGINS = 'https://second.example.com';
  assert.deepEqual(loadEnv().WEB_ORIGINS, [
    'https://app.example.com',
    'https://second.example.com',
  ]);
});

test('Better Auth accepts both browser origins and keeps CSRF and callback checks', async () => {
  // Resolve the auth package's exact dependency, without relying on root hoisting.
  const require = createRequire(
    new URL('../packages/auth/package.json', import.meta.url),
  );
  const { betterAuth } = await import(
    pathToFileURL(require.resolve('better-auth')).href
  );
  const { memoryAdapter } = await import(
    pathToFileURL(require.resolve('better-auth/adapters/memory')).href
  );
  const options = createAuthOptions({
    pool: {} as Pool,
    secret: 'origin-test-secret-with-at-least-32-characters',
    baseURL: localOrigin,
    webOrigin: origins,
    admins: 'admin',
  });
  const auth = betterAuth({
    ...options,
    database: memoryAdapter({
      users: [],
      sessions: [],
      accounts: [],
      verifications: [],
    }),
    logger: { level: 'error' },
  }) as Auth;
  const app = createApp(auth);
  async function signOut(origin?: string, callbackURL = '/threads') {
    // A harmless cookie exercises Better Auth's browser CSRF check without a session or DB.
    return app.request('http://127.0.0.1:3001/api/auth/sign-out', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'origin-test=1',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ callbackURL }),
    });
  }
  for (const origin of origins) {
    const response = await signOut(origin, `${origin}/threads`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.doesNotMatch(response.headers.get('set-cookie') ?? '', /domain=/i);
  }
  for (const origin of rejectedOrigins) {
    assert.equal((await signOut(origin)).status, 403, String(origin));
  }
  assert.equal(
    (await signOut(lanOrigin, 'https://untrusted.example/threads')).status,
    403,
  );

  const account = {
    name: 'Origin test',
    username: 'origin_test',
    email: 'origin-test@example.com',
    password: 'Origin-Test-Password-73!',
  };
  const signup = await app.request(`${localOrigin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { origin: localOrigin, 'content-type': 'application/json' },
    body: JSON.stringify(account),
  });
  assert.equal(signup.status, 200);
  for (const origin of origins) {
    const login = await app.request(`${origin}/api/auth/sign-in/username`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: account.username,
        password: account.password,
      }),
    });
    assert.equal(login.status, 200);
    assert.doesNotMatch(login.headers.get('set-cookie') ?? '', /domain=/i);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const session = await app.request(`${origin}/api/auth/get-session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.username, account.username);
  }
});

test('RPC and legacy HTTP share both origins without weakening roles or session checks', async (t) => {
  let user: { id: string; role: string } | undefined = {
    id: 'origin-test-user',
    role: 'admin',
  };
  let mutations = 0;
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof createApp>[0];
  const service = {
    async deleteModel() {
      mutations++;
    },
  } as unknown as ProviderService;
  const app = createApp(auth, { service, webOrigin: origins });
  let requestOrigin: string | undefined = localOrigin;
  const client = createApiClient(() => `${localOrigin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    if (requestOrigin) headers.set('origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });
  const removeModel = () =>
    client.providers.removeModel({
      params: { providerId: 'provider' },
      query: { modelId: 'model' },
    });
  const removeViaHttp = () =>
    app.request('/api/admin/providers/provider/models?modelId=model', {
      method: 'DELETE',
      headers: requestOrigin ? { origin: requestOrigin } : {},
    });
  for (const origin of origins) {
    requestOrigin = origin;
    await removeModel();
    assert.equal((await removeViaHttp()).status, 204);
  }
  assert.equal(mutations, 4);
  for (const origin of rejectedOrigins) {
    requestOrigin = origin;
    await assert.rejects(removeModel(), { code: 'FORBIDDEN' });
    assert.equal((await removeViaHttp()).status, 403);
  }
  requestOrigin = lanOrigin;
  user = { id: 'origin-test-user', role: 'user' };
  await assert.rejects(removeModel(), { code: 'FORBIDDEN' });
  user = undefined;
  await assert.rejects(removeModel(), { code: 'UNAUTHORIZED' });
  assert.equal(mutations, 4);
});
