import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { MastraBrowser, ScreencastStream } from '@mastra/core/browser';
import {
  browserActionSchema,
  type BrowserAction,
  type BrowserEvent,
} from '@aime/shared/browser';
import { ThreadBrowsers } from './browser/registry.js';
import {
  ThreadBrowserSession,
  type BrowserDriver,
  createBrowserDriver,
} from './browser/session.js';
import { ThreadService } from './service.js';
import { UserBrowser } from './browser/user-browser.js';
import { fakeMemory } from '../../../../../scripts/fixtures/thread-memory.js';
import { openSessionStub } from '../../../../../scripts/fixtures/thread-session.js';

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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('manual navigation starts and reopens an authorized browser in the thread scope', async (t) => {
  const fixture = fakeMemory();
  const created: { userId: string; projectId?: string }[] = [];
  const fakes: ReturnType<typeof fakeDriver>[] = [];
  const browsers = new ThreadBrowsers(
    '/tmp/browser-unit-tests',
    (_id, owner) => {
      created.push({ userId: owner.userId, projectId: owner.projectId });
      const fake = fakeDriver();
      fake.setRunning(false);
      const action = fake.driver.action;
      fake.driver.action = async (input) => {
        if (input.kind === 'navigate') fake.setRunning(true);
        await action(input);
      };
      fakes.push(fake);
      return fake.driver;
    },
  );
  const service = new ThreadService(
    fixture.memory,
    {
      browsers,
      validate: async () => {},
      createWorkspace: async () => '/tmp/browser-test',
      open: openSessionStub,
    },
    { assertMember: async () => ({ role: 'member' }) } as never,
  );
  t.after(() => service.shutdown());
  const thread = await service.createThread('owner', {
    model: null,
    reasoningEffort: 'auto',
    title: 'Manual browser',
  });
  const navigate = { kind: 'navigate' as const, url: 'https://example.com' };
  await assert.rejects(service.browserAction('other', thread.id, navigate), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(
    service.browserAction('owner', thread.id, { kind: 'reload' }),
    { code: 'BROWSER_NOT_RUNNING' },
  );
  assert.equal(created.length, 0);
  const events: BrowserEvent[] = [];
  const unsubscribe = await service.subscribeBrowser(
    'owner',
    thread.id,
    (event) => events.push(event),
  );
  t.after(unsubscribe);
  await service.browserAction('owner', thread.id, navigate);
  await delay(10);
  assert.deepEqual(created, [{ userId: 'owner', projectId: undefined }]);
  assert.equal(
    (await service.getBrowserState('owner', thread.id)).status,
    'ready',
  );
  assert.ok(events.some((event) => event.type === 'frame'));
  await service.browserAction('owner', thread.id, {
    kind: 'text',
    text: 'manual input',
  });
  assert.deepEqual(fakes[0]!.calls, [
    navigate,
    { kind: 'text', text: 'manual input' },
  ]);
  await service.browserAction('owner', thread.id, { kind: 'close' });
  assert.equal((await service.listBrowsers('owner')).length, 0);
  await service.browserAction('owner', thread.id, navigate);
  assert.equal(
    (await service.getBrowserState('owner', thread.id)).status,
    'ready',
  );

  const projectId = 'abcdefghijklmnop';
  const projectThread = await fixture.memory.createThread({
    threadId: 'manual-project-browser',
    resourceId: `project:${projectId}`,
    title: 'Project browser',
    metadata: { createdBy: 'owner' },
  });
  await service.browserAction('other', projectThread.id, navigate);
  assert.deepEqual(created.at(-1), { userId: 'other', projectId });
  assert.equal(
    (await service.getBrowserState('owner', projectThread.id)).status,
    'waiting',
  );
});

test('manual navigation and input remain available during Agent work', async (t) => {
  const { memory } = fakeMemory();
  let created = 0;
  const fake = fakeDriver();
  const browsers = new ThreadBrowsers('/tmp/browser-unit-tests', () => {
    created++;
    return fake.driver;
  });
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
  });
  await service.run('owner', thread.id, {
    id: 'input',
    model: null,
    reasoningEffort: 'auto',
    isImmediate: false,
    parts: [{ type: 'text', text: 'Continue' }],
  });
  assert.equal(created, 0);
  assert.equal((await service.getBrowserState('owner', thread.id)).busy, true);
  const actions: BrowserAction[] = [
    { kind: 'navigate', url: 'https://example.com' },
    {
      kind: 'mouse',
      event: { type: 'mousePressed', x: 20, y: 30, button: 'left' },
    },
    {
      kind: 'mouse',
      event: { type: 'mouseReleased', x: 20, y: 30, button: 'left' },
    },
    {
      kind: 'keyboard',
      event: { type: 'keyDown', key: 'Enter', code: 'Enter' },
    },
    { kind: 'keyboard', event: { type: 'keyUp', key: 'Enter', code: 'Enter' } },
    { kind: 'text', text: '同时输入' },
    { kind: 'mouse', event: { type: 'mouseWheel', x: 20, y: 30, deltaY: 100 } },
    { kind: 'back' },
    { kind: 'forward' },
    { kind: 'reload' },
    { kind: 'tab', index: 0 },
  ];
  for (const action of actions)
    await service.browserAction('owner', thread.id, action);
  assert.equal(created, 1);
  assert.deepEqual(fake.calls, actions);
  assert.equal((await service.getBrowserState('owner', thread.id)).busy, true);
});

test('navigation leaves scheme support to Chromium', () => {
  for (const url of [
    'https://example.com',
    'chrome://version',
    'about:blank',
    'file:///tmp/browser-test.html',
    'data:text/html,hello',
  ])
    assert.equal(
      browserActionSchema.safeParse({ kind: 'navigate', url }).success,
      true,
      url,
    );
  assert.equal(
    browserActionSchema.safeParse({ kind: 'navigate', url: '' }).success,
    false,
  );
});

test(
  'real Chromium closes despite a stuck CDP stop and can reopen an internal page',
  {
    skip: process.env.BROWSER_INTEGRATION !== '1',
    timeout: 30_000,
  },
  async (t) => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'browser-close-'));
    const owner = new UserBrowser(root, 'owner');
    const driver = createBrowserDriver('thread', owner);
    const browser = new ThreadBrowserSession('thread', driver);
    const stopped = deferred();
    const firstFrame = deferred();
    let blockedStops = 0;
    let unsubscribe = () => {};
    t.after(async () => {
      stopped.resolve();
      unsubscribe();
      await browser.dispose();
      await owner.close();
      await rm(root, { recursive: true, force: true });
    });
    await browser.action({
      kind: 'navigate',
      url: 'data:text/html,<input aria-label="Manual input">',
    });
    const manager = await driver.browser.getManagerForThread('thread');
    const input = manager
      .getPage()
      .getByRole('textbox', { name: 'Manual input' });
    await input.focus();
    await browser.action({ kind: 'text', text: '手动交互' });
    assert.equal(await input.inputValue(), '手动交互');
    const context = manager.getContext();
    const createSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (page) => {
      const cdp = await createSession(page);
      const send = cdp.send.bind(cdp);
      cdp.send = ((method, ...args) => {
        if (method === 'Page.stopScreencast') {
          blockedStops++;
          return stopped.promise;
        }
        return send(method, ...args);
      }) as typeof cdp.send;
      return cdp;
    };
    unsubscribe = browser.subscribe((event) => {
      if (event.type === 'frame') firstFrame.resolve();
    });
    await firstFrame.promise;
    const disconnected = new Promise<void>((resolve) =>
      context.once('close', () => resolve()),
    );
    await browser.action({ kind: 'close' });
    await disconnected;
    assert.ok(
      blockedStops > 0,
      'the close actually encountered a stalled CDP command',
    );
    assert.equal(browser.isRunning(), false);
    unsubscribe();
    await browser.action({ kind: 'navigate', url: 'chrome://version' });
    const page = (await driver.browser.getManagerForThread('thread')).getPage();
    assert.equal(page.url(), 'chrome://version/');
    assert.match(
      await page.locator('body').innerText(),
      /Chromium|Google Chrome/,
    );
    stopped.resolve();
    const toolResult = (await driver.browser.getTools().browser_goto.execute!(
      { url: 'chrome://version' },
      { agent: { threadId: 'thread' } } as never,
    )) as { success: boolean };
    assert.equal(toolResult.success, true);
    await browser.action({ kind: 'close' });
  },
);

test(
  'a stalled browser close cannot block room provisioning or another close',
  { timeout: 3000 },
  async (t) => {
    const { memory } = fakeMemory();
    const fake = fakeDriver();
    const closing = deferred();
    const started = deferred();
    const originalAction = fake.driver.action;
    fake.driver.action = async (action) => {
      if (action.kind === 'close') {
        started.resolve();
        await closing.promise;
      }
      await originalAction(action);
    };
    const browsers = new ThreadBrowsers(
      '/tmp/browser-unit-tests',
      () => fake.driver,
    );
    const service = new ThreadService(memory, {
      browsers,
      validate: async () => {},
      createWorkspace: async () => '/tmp/browser-test',
      personalSharedDirectory: async () => '/tmp/browser-test',
      open: openSessionStub,
    });
    t.after(async () => {
      closing.resolve();
      await service.shutdown();
    });
    const binding = {
      roomId: 'room',
      memberId: 'bot',
      role: 'bot' as const,
      threadId: 'room-thread',
      userId: 'owner',
      title: 'Bot',
      settings: { model: null, reasoningEffort: 'auto' as const },
    };
    await service.ensureGroupChatThread(binding);
    browsers.acquire(binding.threadId, 'owner');
    const close = service.browserAction('owner', binding.threadId, {
      kind: 'close',
    });
    await started.promise;
    await service.ensureGroupChatThread(binding);
    await service.getThread('owner', binding.threadId);
    await assert.rejects(
      service.browserAction('other', binding.threadId, { kind: 'close' }),
      { code: 'THREAD_NOT_FOUND' },
    );
    const repeated = service.browserAction('owner', binding.threadId, {
      kind: 'close',
    });
    closing.resolve();
    await Promise.all([close, repeated]);
    assert.equal(
      fake.calls.filter((action) => action.kind === 'close').length,
      1,
    );
  },
);

test(
  'close bypasses a chat submission holding the thread lock',
  { timeout: 3000 },
  async (t) => {
    const { memory } = fakeMemory();
    const fake = fakeDriver();
    const held = deferred();
    const entered = deferred();
    const browsers = new ThreadBrowsers(
      '/tmp/browser-unit-tests',
      () => fake.driver,
    );
    const service = new ThreadService(memory, {
      browsers,
      validate: async () => {
        entered.resolve();
        await held.promise;
      },
      createWorkspace: async () => '/tmp/browser-test',
      personalSharedDirectory: async () => '/tmp/browser-test',
      open: openSessionStub,
    });
    t.after(async () => {
      held.resolve();
      await service.shutdown();
    });
    const binding = {
      roomId: 'room',
      memberId: 'bot',
      role: 'bot' as const,
      threadId: 'room-thread',
      userId: 'owner',
      title: 'Bot',
      settings: { model: null, reasoningEffort: 'auto' as const },
    };
    await service.ensureGroupChatThread(binding);
    browsers.acquire(binding.threadId, 'owner');
    const submission = service.runGroupChat('owner', binding.threadId, {
      id: 'message',
      model: null,
      reasoningEffort: 'auto',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Test' }],
    });
    await entered.promise;
    await service.browserAction('owner', binding.threadId, { kind: 'close' });
    assert.deepEqual(await service.listBrowsers('owner'), []);
    held.resolve();
    await submission;
  },
);

test(
  'close interrupts a stalled capture and discards queued input and late frames',
  { timeout: 3000 },
  async (t) => {
    const fake = fakeDriver();
    const capture = deferred<Awaited<ReturnType<BrowserDriver['capture']>>>();
    const started = deferred();
    fake.driver.capture = async () => {
      started.resolve();
      return capture.promise;
    };
    const browser = new ThreadBrowserSession('thread', fake.driver);
    const events: BrowserEvent[] = [];
    const unsubscribe = browser.subscribe((event) => events.push(event));
    t.after(async () => {
      capture.resolve({ data: 'late', viewport: { width: 1, height: 1 } });
      unsubscribe();
      await browser.dispose();
    });
    await started.promise;
    const queued = assert.rejects(
      browser.action({ kind: 'navigate', url: 'chrome://version' }),
      { code: 'BROWSER_NOT_RUNNING' },
    );
    await browser.action({ kind: 'close' });
    assert.equal(browser.isRunning(), false);
    capture.resolve({ data: 'late', viewport: { width: 1, height: 1 } });
    await queued;
    assert.deepEqual(fake.calls, [{ kind: 'close' }]);
    assert.equal(events.filter((event) => event.type === 'frame').length, 0);
  },
);

test(
  'a late screencast start is disposed after close without publishing frames',
  { timeout: 3000 },
  async (t) => {
    const fake = fakeDriver();
    const start = deferred<ScreencastStream | null>();
    const entered = deferred();
    const createStream =
      fake.driver.browser.startScreencastIfBrowserActive.bind(
        fake.driver.browser,
      );
    const stream = await createStream({ threadId: 'thread' });
    fake.driver.browser.startScreencastIfBrowserActive = async () => {
      entered.resolve();
      return start.promise;
    };
    const browser = new ThreadBrowserSession('thread', fake.driver);
    const events: BrowserEvent[] = [];
    const unsubscribe = browser.subscribe((event) => events.push(event));
    t.after(async () => {
      start.resolve(stream);
      unsubscribe();
      await browser.dispose();
    });
    await entered.promise;
    await browser.action({ kind: 'close' });
    const stopped = new Promise<void>((resolve) =>
      stream!.on('stop', () => resolve()),
    );
    start.resolve(stream);
    await stopped;
    assert.equal(events.filter((event) => event.type === 'frame').length, 0);
  },
);

test(
  'close reaches the driver while screencast stop is stalled',
  { timeout: 3000 },
  async (t) => {
    const fake = fakeDriver();
    const stopping = deferred();
    const frame = deferred();
    const createStream =
      fake.driver.browser.startScreencastIfBrowserActive.bind(
        fake.driver.browser,
      );
    fake.driver.browser.startScreencastIfBrowserActive = async (options) => {
      const stream = (await createStream(options))!;
      const stop = stream.stop.bind(stream);
      stream.stop = async () => {
        await stopping.promise;
        await stop();
      };
      return stream;
    };
    const browser = new ThreadBrowserSession('thread', fake.driver);
    const unsubscribe = browser.subscribe((event) => {
      if (event.type === 'frame') frame.resolve();
    });
    t.after(async () => {
      stopping.resolve();
      unsubscribe();
      await browser.dispose();
    });
    await frame.promise;
    await browser.action({ kind: 'close' });
    assert.equal(browser.isRunning(), false);
    stopping.resolve();
  },
);

test('a stuck close returns an error and can be retried without a stale queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeDriver();
  const held = deferred();
  const original = fake.driver.action;
  let fail = true;
  fake.driver.action = async (action) => {
    if (fail) await held.promise;
    else await original(action);
  };
  const browser = new ThreadBrowserSession('thread', fake.driver);
  const failed = assert.rejects(
    browser.action({ kind: 'close' }),
    /timed out: close browser/,
  );
  t.mock.timers.tick(10_000);
  await failed;
  assert.equal(browser.isRunning(), true);
  held.resolve();
  fail = false;
  await browser.action({ kind: 'close' });
  assert.equal(browser.isRunning(), false);
  await browser.dispose();
});
