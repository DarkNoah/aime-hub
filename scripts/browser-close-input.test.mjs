import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const webRequire = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const { createServer } = await import(
  pathToFileURL(webRequire.resolve('vite')).href
);

test(
  'browser close bypasses blocked frontend input, cancels old requests and permits retry',
  { timeout: 10000 },
  async (t) => {
    const calls = [];
    let releaseClose;
    const heldClose = new Promise((resolve) => {
      releaseClose = resolve;
    });
    const state = {
      status: 'ready',
      tabs: [],
      url: '',
      activeTabIndex: 0,
      busy: false,
    };
    globalThis.browserInputFixture = {
      state: async () => state,
      action: async ({ body }, { signal } = {}) => {
        calls.push(body);
        if (body.kind === 'navigate') {
          await new Promise((_, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            ),
          );
        }
        if (body.kind === 'close') await heldClose;
      },
    };
    const vite = await createServer({
      configFile: false,
      envFile: false,
      root: webRoot,
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        {
          name: 'browser-input-fixture',
          resolveId(id) {
            if (
              id === '@/lib/rpc' ||
              id === '@/components/realtime/event-source'
            )
              return '\0' + id;
          },
          load(id) {
            if (id === '\0@/lib/rpc')
              return 'export const api={threads:{browser:globalThis.browserInputFixture}};export const apiErrorCode=()=>undefined;';
            if (id === '\0@/components/realtime/event-source')
              return 'export class SharedEventSource {}';
          },
        },
      ],
    });
    t.after(async () => {
      releaseClose();
      await vite.close();
      delete globalThis.browserInputFixture;
    });
    const { createBrowserResource } = await vite.ssrLoadModule(
      '/src/components/browser/resource.ts',
    );
    const resource = createBrowserResource('thread', 'session');
    const navigating = resource.action({
      kind: 'navigate',
      url: 'chrome://version',
    });
    // Fill the input queue to verify close is accepted even at its normal limit.
    const queued = Array.from({ length: 63 }, () =>
      resource.action({ kind: 'text', text: 'stale' }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    const closing = resource.action({ kind: 'close' });
    const repeated = resource.action({ kind: 'close' });
    assert.equal(closing, repeated);
    assert.deepEqual(
      calls.map((action) => action.kind),
      ['navigate', 'close'],
    );
    await Promise.all([navigating, ...queued]);
    assert.equal(
      calls.length,
      2,
      'obsolete input must not be sent after close',
    );
    releaseClose();
    await closing;
    await resource.action({ kind: 'text', text: 'fresh' });
    assert.equal(calls.at(-1).text, 'fresh');
  },
);
