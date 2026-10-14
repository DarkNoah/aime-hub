import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  'https://127.0.0.1:5173',
  'https://192.168.1.13:5173',
];

test('WEB_ORIGINS is required, deduplicates in order and validates every origin', (t) => {
  assert.deepEqual(
    normalizeWebOrigins(
      webOriginsEnvSchema.parse(
        ` ${localOrigin}/, ${lanOrigin}, ${localOrigin}, `,
      ),
    ),
    origins,
  );
  assert.deepEqual(normalizeWebOrigins(localOrigin), [localOrigin]);
  for (const value of [
    undefined,
    '',
    ' , , ',
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
    ALLOW_INSECURE_HTTP: 'false',
    ALLOW_ALL_NETWORKS: 'false',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    BETTER_AUTH_SECRET: 'origin-test-secret-with-at-least-32-characters',
    BETTER_AUTH_URL: localOrigin,
    WEB_ORIGIN: localOrigin,
    WEB_ORIGINS: `${localOrigin},${lanOrigin},${localOrigin}/`,
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
  delete process.env.ALLOW_ALL_NETWORKS;
  assert.equal(loadEnv().ALLOW_ALL_NETWORKS, false);
  process.env.ALLOW_ALL_NETWORKS = 'true';
  assert.equal(loadEnv().ALLOW_ALL_NETWORKS, true);
  process.env.ALLOW_ALL_NETWORKS = '1';
  assert.throws(loadEnv, /ALLOW_ALL_NETWORKS/);
  process.env.ALLOW_ALL_NETWORKS = 'false';
  assert.equal(loadEnv().ALLOW_ALL_NETWORKS, false);
  assert.deepEqual(loadEnv().WEB_ORIGINS, origins);
  assert.equal('WEB_ORIGIN' in loadEnv(), false);
  assert.equal('BETTER_AUTH_URL' in loadEnv(), false);
  process.env.WEB_ORIGINS = `${lanOrigin}, ${localOrigin}`;
  assert.deepEqual(loadEnv().WEB_ORIGINS, [lanOrigin, localOrigin]);
  delete process.env.WEB_ORIGINS;
  assert.throws(loadEnv, /WEB_ORIGINS/);
  process.env.WEB_ORIGINS = ' , ';
  assert.throws(loadEnv, /WEB_ORIGINS/);
  process.env.WEB_ORIGINS = 'http://*.example.com';
  assert.throws(loadEnv, /WEB_ORIGINS/);

  process.env.NODE_ENV = 'production';
  process.env.WEB_ORIGINS = `https://app.example.com,${lanOrigin}`;
  assert.throws(loadEnv, /HTTPS/);
  process.env.WEB_ORIGINS =
    'https://app.example.com,https://second.example.com';
  assert.deepEqual(loadEnv().WEB_ORIGINS, [
    'https://app.example.com',
    'https://second.example.com',
  ]);
  process.env.WEB_ORIGINS = lanOrigin;
  assert.throws(loadEnv, /HTTPS/);
  process.env.ALLOW_INSECURE_HTTP = 'true';
  assert.equal(loadEnv().ALLOW_INSECURE_HTTP, true);
  assert.deepEqual(loadEnv().WEB_ORIGINS, [lanOrigin]);
  process.env.ALLOW_INSECURE_HTTP = 'false';
  assert.throws(loadEnv, /HTTPS/);
  process.env.ALLOW_INSECURE_HTTP = '1';
  assert.throws(loadEnv, /ALLOW_INSECURE_HTTP/);
});

async function createMemoryAuth(webOrigins: string[]) {
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
    webOrigin: webOrigins,
    admins: 'admin',
  });
  const resetURLs: string[] = [];
  const auth = betterAuth({
    ...options,
    emailAndPassword: {
      ...options.emailAndPassword,
      sendResetPassword: async ({ url }: { url: string }) => {
        resetURLs.push(url);
      },
    },
    database: memoryAdapter({
      users: [],
      sessions: [],
      accounts: [],
      verifications: [],
    }),
    logger: { level: 'error' },
    // Reset-link tests exercise multiple hosts, not the shared in-memory limiter.
    rateLimit: { enabled: false },
  }) as Auth;
  return { auth, resetURLs };
}

test('Better Auth accepts both browser origins and keeps CSRF and callback checks', async () => {
  const { auth, resetURLs } = await createMemoryAuth(origins);
  const context = await auth.$context;
  // Dynamic allowedHosts must not implicitly trust the other protocol.
  assert.deepEqual([...new Set(context.trustedOrigins)], origins);
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
    assert.doesNotMatch(login.headers.get('set-cookie') ?? '', /; Secure/i);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const session = await app.request(`${origin}/api/auth/get-session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.username, account.username);
    const reset = await app.request(
      `${origin}/api/auth/request-password-reset`,
      {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          email: account.email,
          redirectTo: `${origin}/login`,
        }),
      },
    );
    assert.equal(reset.status, 200);
    assert.equal(new URL(resetURLs.at(-1)!).origin, origin);
  }

  // CLI calls have no request, so they must still get a usable default URL.
  await auth.api.requestPasswordReset({ body: { email: account.email } });
  assert.equal(new URL(resetURLs.at(-1)!).origin, localOrigin);
  await auth.api.requestPasswordReset({
    headers: new Headers({
      host: new URL(lanOrigin).host,
      'x-forwarded-proto': 'http',
    }),
    body: { email: account.email },
  });
  assert.equal(new URL(resetURLs.at(-1)!).origin, lanOrigin);
});

test('dynamic authentication preserves HTTPS proxy hosts and ports and falls back to the first origin', async () => {
  const httpsOrigins = [
    'https://primary.example:8443',
    'https://secondary.example:9443',
  ];
  const { auth, resetURLs } = await createMemoryAuth(httpsOrigins);
  const app = createApp(auth);
  const email = 'proxy-test@example.com';
  const signup = await app.request(
    `${httpsOrigins[0]}/api/auth/sign-up/email`,
    {
      method: 'POST',
      headers: { origin: httpsOrigins[0], 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Proxy Test',
        username: 'proxy_test',
        email,
        password: 'Proxy-Test-Password-73!',
      }),
    },
  );
  assert.equal(signup.status, 200);
  assert.match(signup.headers.get('set-cookie') ?? '', /; Secure/i);
  assert.doesNotMatch(signup.headers.get('set-cookie') ?? '', /domain=/i);
  for (const origin of httpsOrigins) {
    const response = await app.request(
      'http://server:3001/api/auth/request-password-reset',
      {
        method: 'POST',
        headers: {
          host: 'server:3001',
          'x-forwarded-host': new URL(origin).host,
          'x-forwarded-proto': 'https',
          origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(new URL(resetURLs.at(-1)!).origin, origin);
  }
  await auth.api.requestPasswordReset({
    headers: new Headers({
      'x-forwarded-host': 'untrusted.example',
      'x-forwarded-proto': 'http',
    }),
    body: { email },
  });
  assert.equal(new URL(resetURLs.at(-1)!).origin, httpsOrigins[0]);
  for (const origin of [
    'http://primary.example:8443',
    'https://secondary.example:9444',
    'https://untrusted.example',
  ]) {
    const response = await app.request(`${httpsOrigins[0]}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        origin,
        cookie: 'origin-test=1',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
  }
});

test('Vite uses the first origin and overwrites forwarded headers while retaining the browser port', async (t) => {
  const backend = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.headers));
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        backend.listening
          ? backend.close((error) => (error ? reject(error) : resolve()))
          : resolve(),
      ),
  );
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  assert.ok(address && typeof address !== 'string');
  const previous = {
    WEB_ORIGINS: process.env.WEB_ORIGINS,
    SERVER_PORT: process.env.SERVER_PORT,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const defaultOrigin = 'http://192.168.1.13:5189';
  process.env.WEB_ORIGINS = `${defaultOrigin},${localOrigin}`;
  process.env.SERVER_PORT = String(address.port);
  const require = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  );
  const { createServer: createViteServer, loadConfigFromFile } = await import(
    pathToFileURL(require.resolve('vite')).href
  );
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    fileURLToPath(new URL('../apps/web/vite.config.ts', import.meta.url)),
  );
  assert.ok(loaded);
  assert.equal(loaded.config.server.port, 5189);
  const vite = await createViteServer({
    ...loaded.config,
    configFile: false,
    root: fileURLToPath(new URL('../apps/web', import.meta.url)),
    server: {
      ...loaded.config.server,
      host: '127.0.0.1',
      port: 0,
      watch: null,
      hmr: false,
    },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => vite.close());
  await vite.listen();
  const logs: string[] = [];
  t.mock.method(vite.config.logger, 'info', (message: string) =>
    logs.push(message),
  );
  vite.printUrls();
  assert.ok(logs.includes(`Web entry: ${defaultOrigin}`));
  const viteAddress = vite.httpServer.address();
  assert.ok(viteAddress && typeof viteAddress !== 'string');
  for (const origin of origins) {
    // Use separate raw HTTP requests so each request carries its own Host header.
    const request = httpRequest(
      `http://127.0.0.1:${viteAddress.port}/api/headers`,
      {
        agent: false,
        headers: {
          host: new URL(origin).host,
          'x-forwarded-host': 'untrusted.example',
          'x-forwarded-proto': 'https',
        },
      },
    );
    request.end();
    const [response] = await once(request, 'response');
    let body = '';
    for await (const chunk of response) body += chunk;
    assert.equal(response.statusCode, 200);
    const headers = JSON.parse(body);
    assert.equal(headers.host, new URL(origin).host);
    assert.equal(headers['x-forwarded-host'], new URL(origin).host);
    assert.equal(headers['x-forwarded-proto'], 'http');
  }
});

test('static builds work without runtime origins while development requires WEB_ORIGINS', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-origin-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webDir = join(root, 'apps/web');
  const sharedDir = join(root, 'packages/shared/src');
  await Promise.all([
    mkdir(webDir, { recursive: true }),
    mkdir(sharedDir, { recursive: true }),
  ]);
  const configPath = join(webDir, 'vite.config.ts');
  await Promise.all([
    cp(new URL('../apps/web/vite.config.ts', import.meta.url), configPath),
    cp(
      new URL('../packages/shared/src/web-origins.ts', import.meta.url),
      join(sharedDir, 'web-origins.ts'),
    ),
    symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    ),
    symlink(
      fileURLToPath(new URL('../apps/web/node_modules', import.meta.url)),
      join(webDir, 'node_modules'),
      'dir',
    ),
  ]);
  const previous = process.env.WEB_ORIGINS;
  delete process.env.WEB_ORIGINS;
  t.after(() => {
    if (previous === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = previous;
  });
  const require = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  );
  const { loadConfigFromFile } = await import(
    pathToFileURL(require.resolve('vite')).href
  );
  const build = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    configPath,
  );
  assert.ok(build);
  assert.equal(build.config.server.port, 5173);
  await assert.rejects(
    loadConfigFromFile({ command: 'serve', mode: 'development' }, configPath),
  );
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
