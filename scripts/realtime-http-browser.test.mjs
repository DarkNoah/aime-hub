/** Real HTTP origins and production SSE routes, with isolated auth and feeds. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { realtimeRoutes } from '../apps/server/src/modules/realtime/routes.ts';
import { eventStream } from '../apps/server/src/modules/threads/event-stream.ts';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const serverRequire = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
);
const { Hono } = serverRequire('hono');
const { getRequestListener } = serverRequire('@hono/node-server');
const [{ createServer }, { default: playwright }] = await Promise.all([
  import(pathToFileURL(webRequire.resolve('vite')).href),
  import(pathToFileURL(serverRequire.resolve('playwright-core')).href),
]);

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail('Realtime connection did not reach the expected state');
}

test(
  'realtime works on insecure HTTP with SharedWorker and per-tab fallback',
  { timeout: 60000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.realtime-http-test-'));
    const origins = [];
    const connections = new Set();
    const feeds = new Map();
    const failures = [];
    let vite, browser, server;
    t.after(async () => {
      await browser?.close();
      for (const controller of connections) controller.abort();
      await vite?.close();
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(fixture, { recursive: true, force: true });
    });
    const api = new Hono();
    api.use('*', async (c, next) => {
      await next();
      // Closing a worker can race its final control request; 409 requests reconnect.
      if (c.res.status >= 400 && c.res.status !== 409)
        failures.push(`${c.req.method} ${c.req.path}: ${c.res.status}`);
    });
    api.route(
      '/api/realtime',
      realtimeRoutes(
        {
          api: {
            getSession: async () => ({
              user: { id: 'fixture' },
              session: { id: 'fixture-session' },
            }),
          },
        },
        (request) => api.fetch(request),
        origins,
      ),
    );
    for (const url of ['/api/threads/events', '/api/notifications/events']) {
      api.get(url, (c) =>
        eventStream(
          c.req.raw.signal,
          (send) => {
            feeds.set(url, send);
            send('snapshot', { version: 0, url });
            return () => feeds.delete(url);
          },
          async () => undefined,
        ),
      );
    }
    server = createHttpServer(
      getRequestListener((request) => {
        if (
          request.method === 'GET' &&
          new URL(request.url).pathname.startsWith('/api/realtime/')
        ) {
          const controller = new AbortController();
          const signal = AbortSignal.any([controller.signal, request.signal]);
          connections.add(controller);
          signal.addEventListener(
            'abort',
            () => connections.delete(controller),
            { once: true },
          );
          return api.fetch(new Request(request, { signal }));
        }
        return api.fetch(request);
      }),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await writeFile(
      path.join(fixture, 'entry.ts'),
      `
import { SharedEventSource } from '/src/components/realtime/event-source';
import { browserWorkspaceState } from '/src/components/chat/workspace-navigation';
const events = [];
const sources = ['/api/threads/events', '/api/notifications/events'].map(url => {
  const source = new SharedEventSource(url, 'fixture-session');
  for (const kind of ['snapshot', 'update', 'error']) source.addEventListener(kind, event => {
    events.push({ kind, url, data: event.data ? JSON.parse(event.data) : null });
  });
  return source;
});
window.fixture = { events, workspace: browserWorkspaceState('thread0000000001'), close: () => sources.forEach(source => source.close()) };
`,
    );
    vite = await createServer({
      configFile: false,
      envFile: false,
      root: webRoot,
      cacheDir: path.join(fixture, 'node_modules/.vite'),
      optimizeDeps: { noDiscovery: true, include: [] },
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      plugins: [
        {
          name: 'realtime-http-fixture',
          configureServer(dev) {
            dev.middlewares.use((req, res, next) => {
              if (req.url !== '/realtime-test') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                `<!doctype html><script type="module" src="/${path.basename(fixture)}/entry.ts"></script>`,
              );
            });
          },
        },
      ],
      server: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['realtime-http.test'],
        proxy: { '/api': `http://127.0.0.1:${server.address().port}` },
      },
    });
    await vite.listen();
    const port = vite.httpServer.address().port;
    origins.push(
      `http://127.0.0.1:${port}`,
      `http://realtime-http.test:${port}`,
    );
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [
        '--host-resolver-rules=MAP realtime-http.test 127.0.0.1',
        '--no-proxy-server',
      ],
    });

    for (const scenario of [
      {
        name: 'localhost native UUID / SharedWorker',
        origin: origins[0],
        secure: true,
        fallback: false,
      },
      {
        name: 'HTTP fallback UUID / SharedWorker',
        origin: origins[1],
        secure: false,
        fallback: false,
      },
      {
        name: 'HTTP fallback UUID / no SharedWorker or Web Locks',
        origin: origins[1],
        secure: false,
        fallback: true,
      },
    ]) {
      await t.test(scenario.name, async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript((fallback) => {
          window.workerReady = false;
          if (fallback)
            Object.defineProperty(window, 'SharedWorker', { value: undefined });
          else {
            const NativeSharedWorker = window.SharedWorker;
            window.SharedWorker = class extends NativeSharedWorker {
              constructor(...args) {
                super(...args);
                this.port.addEventListener('message', ({ data }) => {
                  if (data.type === 'ready') window.workerReady = true;
                });
              }
            };
          }
        }, scenario.fallback);
        await page.goto(`${scenario.origin}/realtime-test`);
        assert.deepEqual(
          await page.evaluate(() => ({
            secure: isSecureContext,
            uuid: typeof crypto.randomUUID,
            locks: typeof navigator.locks,
          })),
          {
            secure: scenario.secure,
            uuid: scenario.secure ? 'function' : 'undefined',
            locks: scenario.secure ? 'object' : 'undefined',
          },
        );
        await page.waitForFunction(
          () =>
            window.fixture?.events.filter((event) => event.kind === 'snapshot')
              .length === 2,
          undefined,
          { timeout: 10000 },
        );
        assert.equal(
          await page.evaluate(() => window.workerReady),
          !scenario.fallback,
        );
        assert.match(
          await page.evaluate(
            () => window.fixture.workspace.chatWorkspace.requestId,
          ),
          /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
        assert.equal(
          connections.size,
          1,
          'logical feeds must share a single physical connection',
        );
        assert.equal(feeds.size, 2);
        for (const [url, send] of feeds) send('update', { version: 1, url });
        await page.waitForFunction(
          () =>
            window.fixture.events.filter(
              (event) => event.kind === 'update' && event.data.version === 1,
            ).length === 2,
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(failures, []);
        await page.evaluate(() => window.fixture.close());
        await context.close();
        await until(() => feeds.size === 0 && connections.size === 0);
      });
    }
  },
);
