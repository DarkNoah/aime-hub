import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { MastraBrowser, ScreencastStream } from '@mastra/core/browser';
import {
  browserActionSchema,
  type BrowserAction,
  type BrowserEvent,
} from '@aime/shared/browser';
import { ThreadBrowsers } from './browser/registry.js';
import { ThreadBrowserSession, type BrowserDriver } from './browser/session.js';
import { ThreadService, type ChatRunner } from './service.js';
import { fakeMemory } from '../../../../../scripts/fixtures/thread-memory.js';
import { openSessionStub } from '../../../../../scripts/fixtures/thread-session.js';
import { browserPoint } from '../../../../web/src/components/browser/coordinates.js';
import { ThreadBrowser, ThreadBrowserRouter } from './browser.js';
import { RequestContext } from '@mastra/core/request-context';
import { UserBrowser } from './browser/user-browser.js';

function fakeDriver() {
  let running = true;
  let starts = 0;
  let stops = 0;
  let closed = 0;
  const calls: BrowserAction[] = [];
  let events = new EventEmitter();
  const driver: BrowserDriver = {
    browser: {
      hasThreadSession: () => running,
      isBrowserRunning: () => running,
      getBrowserState: async () =>
        running
          ? { tabs: [{ url: 'https://example.com' }], activeTabIndex: 0 }
          : null,
      async startScreencastIfBrowserActive() {
        if (!running) return null;
        starts++;
        events = new EventEmitter();
        let active = true;
        const stream = Object.assign(events, {
          isActive: () => active,
          async stop() {
            active = false;
            stops++;
            events.emit('stop', 'manual');
          },
          async reconnect() {},
          emitUrl(url: string) {
            events.emit('url', url);
          },
        });
        return stream as ScreencastStream;
      },
      async close() {
        running = false;
        closed++;
      },
    } as unknown as MastraBrowser,
    async action(action) {
      calls.push(action);
      if (action.kind === 'close') running = false;
    },
    async capture() {
      return { data: 'seed', viewport: { width: 1280, height: 720 } };
    },
  };
  return {
    driver,
    calls,
    counters: () => ({ starts, stops, closed }),
    setRunning: (value: boolean) => {
      running = value;
    },
    frame: (data: string) =>
      events.emit('frame', { data, viewport: { width: 1280, height: 720 } }),
  };
}

test('browser_tabs list on a terminated or unopened browser does not launch it', async () => {
  const browser = new ThreadBrowser(
    new UserBrowser('/tmp/browser-unit-tests', 'owner'),
    'closed-thread',
  );
  const tool = browser.getTools().browser_tabs;
  const result = await tool.execute!({ action: 'list' }, {
    agent: { threadId: 'closed-thread' },
  } as never);
  assert.deepEqual(result, {
    success: true,
    tabs: [],
    hint: 'No browser is running. Open a URL or create a new tab to start a fresh browser session.',
  });
  assert.equal(browser.hasThreadSession('closed-thread'), false);
});

test('multiple viewers share one screencast, receive its final frame and do not close the browser', async (t) => {
  const fake = fakeDriver();
  const browser = new ThreadBrowserSession('thread', fake.driver);
  t.after(() => browser.dispose());
  const first: BrowserEvent[] = [];
  const second: BrowserEvent[] = [];
  const stopFirst = browser.subscribe((event) => first.push(event));
  const stopSecond = browser.subscribe((event) => second.push(event));
  await delay(10);
  assert.equal(fake.counters().starts, 1);
  fake.frame('first');
  fake.frame('last');
  await delay(100);
  assert.equal(
    second.filter((event) => event.type === 'frame').at(-1)?.frame.data,
    'last',
  );
  stopFirst();
  await delay(10);
  assert.equal(fake.counters().stops, 0);
  stopSecond();
  await delay(10);
  assert.equal(fake.counters().stops, 1);
  assert.equal(browser.isRunning(), true);
  assert.equal(fake.counters().closed, 0);
  const stopReopened = browser.subscribe((event) => second.push(event));
  await delay(10);
  assert.equal(fake.counters().starts, 2);
  assert.equal(
    second.filter((event) => event.type === 'frame').at(-1)?.frame.data,
    'seed',
  );
  stopReopened();
});

test('registry preserves a running browser through chat session release and explicitly closes it', async (t) => {
  const fake = fakeDriver();
  const browsers = new ThreadBrowsers(
    '/tmp/browser-unit-tests',
    () => fake.driver,
  );
  t.after(() => browsers.dispose());
  const browser = browsers.acquire('thread', 'owner');
  await browsers.releaseInactive('thread');
  assert.equal(browsers.acquire('thread', 'owner'), browser);
  await browser.action({ kind: 'close' });
  assert.equal(browser.isRunning(), false);
  await browsers.releaseInactive('thread');
  assert.equal(browsers.get('thread', 'owner'), undefined);
  assert.equal(fake.counters().closed, 1);
});

test('watching an unstarted thread never creates a browser and attaches when the Agent starts one', async (t) => {
  const fake = fakeDriver();
  let created = 0;
  const browsers = new ThreadBrowsers('/tmp/browser-unit-tests', () => {
    created++;
    return fake.driver;
  });
  t.after(() => browsers.dispose());
  const events: BrowserEvent[] = [];
  const stop = browsers.subscribe('thread', 'owner', (event) =>
    events.push(event),
  );
  assert.equal(created, 0);
  assert.deepEqual(
    events.map((event) => event.type === 'state' && event.state.status),
    ['waiting'],
  );
  browsers.acquire('thread', 'owner');
  await delay(10);
  assert.equal(created, 1);
  assert.ok(events.some((event) => event.type === 'frame'));
  stop();
});

test('browser catalog, frames and input enforce thread access; Agent work blocks input but permits close', async (t) => {
  const fixture = fakeMemory();
  const fake = fakeDriver();
  const browsers = new ThreadBrowsers(
    '/tmp/browser-unit-tests',
    () => fake.driver,
  );
  const runner: ChatRunner = {
    browsers,
    validate: async () => {},
    createWorkspace: async () => '/tmp/browser-test',
    open: openSessionStub,
  };
  const service = new ThreadService(fixture.memory, runner);
  t.after(() => service.shutdown());
  const thread = await service.createThread('owner', {
    model: null,
    reasoningEffort: 'auto',
    title: 'Browser test',
  });
  browsers.acquire(thread.id, 'owner');
  assert.equal((await service.listBrowsers('owner')).length, 1);
  assert.equal((await service.listBrowsers('other')).length, 0);
  await assert.rejects(service.getBrowserState('other', thread.id), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(
    service.subscribeBrowser('other', thread.id, () =>
      assert.fail('Private frame leaked'),
    ),
    { code: 'THREAD_NOT_FOUND' },
  );
  await assert.rejects(
    service.browserAction('other', thread.id, { kind: 'close' }),
    { code: 'THREAD_NOT_FOUND' },
  );
  await service.browserAction('owner', thread.id, {
    kind: 'text',
    text: '中文粘贴',
  });
  assert.equal(fake.calls.length, 1);
  await service.run('owner', thread.id, {
    id: 'input-1',
    model: null,
    reasoningEffort: 'auto',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Continue' }],
  });
  assert.equal((await service.getBrowserState('owner', thread.id)).busy, true);
  await assert.rejects(
    service.browserAction('owner', thread.id, { kind: 'text', text: 'race' }),
    { code: 'BROWSER_BUSY' },
  );
  await service.browserAction('owner', thread.id, { kind: 'close' });
  assert.equal((await service.listBrowsers('owner')).length, 0);
});

test('closing a thread also closes browsers retained independently of its native chat session', async (t) => {
  const { memory } = fakeMemory();
  const fake = fakeDriver();
  const browsers = new ThreadBrowsers(
    '/tmp/browser-unit-tests',
    () => fake.driver,
  );
  const service = new ThreadService(memory, {
    browsers,
    validate: async () => {},
    createWorkspace: async () => '/tmp/browser-test',
    open: openSessionStub,
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('owner', {
    model: null,
    reasoningEffort: 'auto',
    title: 'Browser test',
  });
  browsers.acquire(thread.id, 'owner');
  await service.deleteThread('owner', thread.id);
  assert.equal(browsers.get(thread.id, 'owner'), undefined);
  assert.equal(fake.counters().closed, 1);
});

test('navigation accepts only HTTP(S) and coordinates account for scaling and letterboxing', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,test',
    'https://user:secret@example.com',
  ])
    assert.equal(
      browserActionSchema.safeParse({ kind: 'navigate', url }).success,
      false,
    );
  assert.equal(
    browserActionSchema.safeParse({
      kind: 'navigate',
      url: 'https://example.com',
    }).success,
    true,
  );
  assert.equal(
    browserActionSchema.safeParse({
      kind: 'mouse',
      event: { type: 'mouseMoved', x: NaN, y: 2 },
    }).success,
    false,
  );
  const rect = { left: 20, top: 30, width: 640, height: 480 };
  const viewport = { width: 1280, height: 720 };
  assert.deepEqual(browserPoint(rect, viewport, 340, 270), { x: 640, y: 360 });
  assert.equal(browserPoint(rect, viewport, 340, 40), null);
  assert.deepEqual(browserPoint(rect, viewport, 340, 40, true), {
    x: 640,
    y: 0,
  });
});

test('registry keeps different users in the same project thread isolated', async (t) => {
  const fake = fakeDriver();
  const browsers = new ThreadBrowsers(
    '/tmp/browser-unit-tests',
    () => fake.driver,
  );
  t.after(() => browsers.dispose());
  const alice = browsers.acquire('shared-project-thread', 'alice');
  const bob = browsers.acquire('shared-project-thread', 'bob');
  assert.notEqual(alice, bob);
  assert.equal(browsers.get('shared-project-thread', 'alice'), alice);
  assert.deepEqual(
    [...browsers.entries('alice')],
    [['shared-project-thread', alice]],
  );
});

test(
  'persistent user browsers share login data, isolate thread pages and start without historical pages',
  {
    skip: process.env.BROWSER_INTEGRATION !== '1',
    timeout: 90000,
  },
  async (t) => {
    const { mkdtemp, rm, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createServer } = await import('node:http');
    const { createBrowserDriver } = await import('./browser/session.js');
    const root = await mkdtemp(join(tmpdir(), 'browser-profile-test-'));
    const hits: string[] = [];
    const userAgents = new Map<string, string | undefined>();
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      userAgents.set(req.url ?? '', req.headers['user-agent']);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<html><head><title>${req.url}</title><script>document.documentElement.dataset.webdriver = String(navigator.webdriver); document.documentElement.dataset.userAgent = navigator.userAgent;</script></head><body style="background:#fff"><input aria-label="text"><a href="/popup" target="_blank">Popup</a></body></html>`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const owner = new UserBrowser(root, 'alice');
    const other = new UserBrowser(root, 'bob');
    const owners = [owner, other];
    const a = new ThreadBrowser(owner, 'a');
    const b = new ThreadBrowser(owner, 'b');
    const c = new ThreadBrowser(other, 'c');
    t.after(async () => {
      await Promise.allSettled(owners.map((item) => item.close()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    await Promise.all([a.ensureReady(), b.ensureReady(), c.ensureReady()]);
    const ma = await a.getManagerForThread('a');
    const mb = await b.getManagerForThread('b');
    const mc = await c.getManagerForThread('c');
    assert.equal(ma.getContext(), mb.getContext());
    assert.notEqual(ma.getContext(), mc.getContext());
    assert.equal((await stat(owner.directory)).mode & 0o777, 0o700);
    await Promise.all([
      a.goto({ url: `${origin}/a` }, 'a'),
      b.goto({ url: `${origin}/b` }, 'b'),
      c.goto({ url: `${origin}/c` }, 'c'),
    ]);
    const assertStealth = async (page: ReturnType<typeof ma.getPage>) => {
      const identity = await page.evaluate(() => ({
        webdriver: document.documentElement.dataset.webdriver,
        userAgent: document.documentElement.dataset.userAgent,
      }));
      assert.notEqual(identity.webdriver, 'true');
      assert.ok(identity.userAgent);
      assert.doesNotMatch(identity.userAgent, /HeadlessChrome/, page.url());
      assert.equal(
        identity.userAgent,
        userAgents.get(new URL(page.url()).pathname),
      );
    };
    await Promise.all(
      [ma, mb, mc].map((manager) => assertStealth(manager.getPage())),
    );
    await ma.getPage().evaluate(async () => {
      document.cookie = 'session_login=alice; path=/';
      document.cookie = 'persistent_login=alice; path=/; max-age=86400';
      localStorage.setItem('account', 'alice');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('browser-login', 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('auth');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('auth', 'readwrite');
          tx.objectStore('auth').put('alice', 'account');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    });
    assert.match(
      await mb.getPage().evaluate(() => document.cookie),
      /session_login=alice/,
    );
    assert.equal(
      await mb.getPage().evaluate(() => localStorage.getItem('account')),
      'alice',
    );
    assert.equal(await mc.getPage().evaluate(() => document.cookie), '');
    assert.equal(
      await mc.getPage().evaluate(() => localStorage.getItem('account')),
      null,
    );

    const projectAlice = new ThreadBrowser(owner, 'shared-project');
    const projectBob = new ThreadBrowser(other, 'shared-project');
    const router = new ThreadBrowserRouter(
      (userId) => (userId === 'alice' ? projectAlice : projectBob),
      'alice',
    );
    const routedTools = router.getTools();
    const requestContext = new RequestContext();
    requestContext.set('userId', 'bob');
    await routedTools.browser_goto!.execute!({ url: `${origin}/project-bob` }, {
      requestContext,
      agent: { threadId: 'shared-project' },
    } as never);
    assert.equal(projectAlice.isBrowserRunning(), false);
    const projectBobPage = (await projectBob.getManagerForThread()).getPage();
    assert.equal(await projectBobPage.evaluate(() => document.cookie), '');
    requestContext.set('userId', 'alice');
    await routedTools.browser_goto!.execute!(
      { url: `${origin}/project-alice` },
      { requestContext, agent: { threadId: 'shared-project' } } as never,
    );
    assert.match(
      await (
        await projectAlice.getManagerForThread()
      )
        .getPage()
        .evaluate(() => document.cookie),
      /session_login=alice/,
    );
    assert.equal(projectBobPage.url(), `${origin}/project-bob`);

    const aTools = a.getTools();
    const callA = (name: string, input: unknown) =>
      aTools[name]!.execute!(input, { agent: { threadId: 'a' } } as never);
    await callA('browser_tabs', { action: 'new', url: `${origin}/a2` });
    assert.deepEqual(
      ma.getPages().map((page) => page.url()),
      [`${origin}/a`, `${origin}/a2`],
    );
    assert.deepEqual(
      mb.getPages().map((page) => page.url()),
      [`${origin}/b`],
    );
    await callA('browser_tabs', { action: 'switch', index: 0 });
    assert.equal(mb.getPage().url(), `${origin}/b`);
    const opener = ma.getPage();
    const [popup] = await Promise.all([
      opener.waitForEvent('popup'),
      opener.getByText('Popup', { exact: true }).click(),
    ]);
    await popup.waitForLoadState();
    assert.equal(ma.getPage(), popup);
    assert.equal(ma.getPages().length, 3);
    assert.equal(mb.getPages().length, 1);
    await callA('browser_tabs', { action: 'close', index: 1 });
    assert.equal(ma.getPages().length, 2);
    assert.equal(ma.getPage(), popup);
    assert.equal(mb.getPage().url(), `${origin}/b`);
    const snapshot = (await callA('browser_snapshot', {})) as {
      success: boolean;
      snapshot: string;
    };
    assert.equal(snapshot.success, true);
    assert.match(snapshot.snapshot, /@e\d+/);
    const ref = snapshot.snapshot.match(/textbox "text".*?(@e\d+)/)?.[1];
    assert.ok(ref);
    await callA('browser_type', { ref, text: 'only-a' });
    assert.equal(await ma.getPage().locator('input').inputValue(), 'only-a');
    assert.equal(await mb.getPage().locator('input').inputValue(), '');

    const stream = await b.startScreencast({ threadId: 'b', everyNthFrame: 1 });
    const urls: string[] = [];
    stream.on('url', (url) => urls.push(url));
    const frameReceived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('No screencast frame')),
        5000,
      );
      stream.once('frame', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await mb.getPage().evaluate(() => {
      document.body.style.background = '#34d399';
    });
    await frameReceived;
    await a.goto({ url: `${origin}/a-final` }, 'a');
    // Upstream injects popup evasions after creation; only subsequent
    // navigations are covered, not the popup's first request/document.
    await assertStealth(popup);
    assert.deepEqual(urls, []);
    const driverB = createBrowserDriver('b', owner);
    await mb.getPage().locator('input').focus();
    await driverB.action({ kind: 'text', text: '线程 B' });
    assert.equal(await mb.getPage().locator('input').inputValue(), '线程 B');
    assert.equal(await ma.getPage().locator('input').inputValue(), '');

    // Releasing a chat only closes its pages, even while another chat is using the profile.
    await a.release();
    assert.equal(b.isBrowserRunning('b'), true);
    assert.equal(mb.getPage().url(), `${origin}/b`);
    const d = new ThreadBrowser(owner, 'd');
    await d.ensureReady();
    await d.goto({ url: `${origin}/d` }, 'd');
    let closedNotifications = 0;
    d.onBrowserClosed(() => {
      closedNotifications++;
    }, 'd');
    const bTools = b.getTools();
    await bTools.browser_close!.execute!({}, {
      agent: { threadId: 'b' },
    } as never);
    assert.equal(b.isBrowserRunning('b'), false);
    assert.equal(d.isBrowserRunning('d'), false);
    assert.equal(closedNotifications, 1);
    assert.equal(stream.isActive(), false);
    assert.equal(c.isBrowserRunning('c'), true);
    assert.equal(projectAlice.isBrowserRunning(), false);
    assert.equal(projectBob.isBrowserRunning(), true);
    const closedList = (await bTools.browser_tabs!.execute!(
      { action: 'list' },
      { agent: { threadId: 'b' } } as never,
    )) as { tabs: unknown[] };
    assert.deepEqual(closedList.tabs, []);
    assert.equal(b.isBrowserRunning('b'), false);
    const starting = b.ensureReady();
    const stopping = owner.close();
    assert.equal(
      (await Promise.allSettled([starting, stopping]))[0]!.status,
      'rejected',
    );
    assert.equal(b.isBrowserRunning(), false);

    // A new registry/process-equivalent owner reloads the profile without visiting old URLs.
    const hitsBeforeRestart = hits.length;
    const restarted = new UserBrowser(root, 'alice');
    owners.push(restarted);
    const fresh = new ThreadBrowser(restarted, 'fresh');
    await fresh.ensureReady();
    const mf = await fresh.getManagerForThread('fresh');
    assert.deepEqual(
      mf.getPages().map((page) => page.url()),
      ['about:blank'],
    );
    assert.equal(hits.length, hitsBeforeRestart);
    await fresh.goto({ url: `${origin}/fresh` }, 'fresh');
    await assertStealth(mf.getPage());
    const cookie = await mf.getPage().evaluate(() => document.cookie);
    assert.match(cookie, /session_login=alice/);
    assert.match(cookie, /persistent_login=alice/);
    assert.equal(
      await mf.getPage().evaluate(() => localStorage.getItem('account')),
      'alice',
    );
    assert.equal(
      await mf.getPage().evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('browser-login', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const get = db
                .transaction('auth')
                .objectStore('auth')
                .get('account');
              get.onsuccess = () => {
                resolve(get.result);
                db.close();
              };
            };
          }),
      ),
      'alice',
    );
    // End from the UI's action path too, without deleting credentials.
    await createBrowserDriver('fresh', restarted).action({ kind: 'close' });
    assert.equal(fresh.isBrowserRunning(), false);
    await restarted.close();
  },
);

test('shared project access does not expose another member’s browser, including Agent context', async (t) => {
  const { memory } = fakeMemory();
  const alice = fakeDriver();
  const bob = fakeDriver();
  const browsers = new ThreadBrowsers(
    '/tmp/browser-unit-tests',
    (_id, owner) => (owner.userId === 'alice' ? alice.driver : bob.driver),
  );
  const service = new ThreadService(
    memory,
    {
      browsers,
      validate: async () => {},
      createWorkspace: async () => '/tmp/browser-test',
      open: openSessionStub,
    },
    { assertMember: async () => ({ role: 'member' }) } as never,
  );
  t.after(() => service.shutdown());
  const thread = await memory.createThread({
    threadId: 'shared-thread-01',
    resourceId: 'project:abcdefghijklmnop',
    title: 'Shared',
    metadata: { createdBy: 'alice' },
  });
  browsers.acquire(thread.id, 'alice');
  assert.equal((await service.listBrowsers('bob')).length, 0);
  assert.equal(
    (await service.getBrowserState('bob', thread.id)).status,
    'waiting',
  );
  await assert.rejects(
    service.browserAction('bob', thread.id, { kind: 'close' }),
    { code: 'BROWSER_NOT_RUNNING' },
  );
  let author = 'alice';
  const context = browsers.agentContext(thread.id, () => author);
  assert.equal((await context.getState!())?.isOpen, true);
  author = 'bob';
  assert.equal((await context.getState!())?.isOpen, false);
  const events: BrowserEvent[] = [];
  const unsubscribe = await service.subscribeBrowser(
    'bob',
    thread.id,
    (event) => events.push(event),
  );
  t.after(unsubscribe);
  alice.frame('private-alice-frame');
  assert.equal(
    events.some((event) => event.type === 'frame'),
    false,
  );
  browsers.acquire(thread.id, 'bob');
  await service.browserAction('bob', thread.id, { kind: 'close' });
  assert.equal(alice.calls.length, 0);
  assert.equal((await service.listBrowsers('alice')).length, 1);
  assert.equal((await service.listBrowsers('bob')).length, 0);
});
