import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'patchright-core';
import { UserBrowser } from './browser/user-browser.js';
import {
  createBrowserDriver,
  ThreadBrowserSession,
} from './browser/session.js';

const idleMs = 15 * 60 * 1000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakePage extends EventEmitter {
  private closed = false;
  private currentUrl = 'about:blank';
  isClosed() {
    return this.closed;
  }
  url() {
    return this.currentUrl;
  }
  async title() {
    return 'Test page';
  }
  async goto(url: string) {
    this.currentUrl = url;
  }
  viewportSize() {
    return { width: 1280, height: 720 };
  }
  async screenshot() {
    return Buffer.from('frame');
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class FakeContext extends EventEmitter {
  private owned: FakePage[] = [];
  closed = false;
  closeCalls = 0;
  failClose = false;
  pages() {
    return this.owned.filter((page) => !page.isClosed());
  }
  async newPage() {
    const page = new FakePage();
    this.owned.push(page);
    return page as unknown as Page;
  }
  async cookies() {
    return [];
  }
  async addCookies() {}
  async close() {
    this.closeCalls++;
    if (this.failClose) throw new Error('Could not close browser');
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.owned.map((page) => page.close()));
    this.emit('close');
  }
}

async function settled(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.ok(predicate(), 'browser lifecycle operation did not settle');
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'browser-idle-'));
  const contexts: FakeContext[] = [];
  const owners: UserBrowser[] = [];
  const sessions: ThreadBrowserSession[] = [];
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    const context = new FakeContext();
    contexts.push(context);
    return context as unknown as BrowserContext;
  });
  t.after(async () => {
    for (const context of contexts) context.failClose = false;
    await Promise.all(sessions.map((session) => session.dispose()));
    await Promise.all(owners.map((owner) => owner.close()));
    await rm(root, { recursive: true, force: true });
  });
  const owner = (userId = 'user', projectId?: string) => {
    const value = new UserBrowser(root, userId, undefined, projectId);
    owners.push(value);
    return value;
  };
  const session = (browser: UserBrowser, threadId = 'thread') => {
    const driver = createBrowserDriver(threadId, browser);
    const value = new ThreadBrowserSession(threadId, driver);
    sessions.push(value);
    return { session: value, driver };
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return { contexts, owner, session };
}

test('a browser closes after 15 idle minutes and reports the closed state', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  const { session } = fake.session(owner);
  await session.action({ kind: 'navigate', url: 'https://example.com' });
  const context = fake.contexts[0]!;

  t.mock.timers.tick(idleMs - 1);
  assert.equal(context.closeCalls, 0);
  assert.equal(session.isRunning(), true);
  t.mock.timers.tick(1);
  await settled(() => context.closed && !owner.isClosing);

  assert.equal(context.closeCalls, 1);
  assert.equal(session.isRunning(), false);
  assert.equal((await session.state()).status, 'closed');
});

test('unused browsers and listing unopened tabs never launch Chromium', async (t) => {
  const fake = await fixture(t);
  const { session } = fake.session(fake.owner());
  await session.exec('tabs', {});
  await session.state();
  t.mock.timers.tick(idleMs * 2);
  await setImmediate();
  assert.equal(fake.contexts.length, 0);
});

test('closing the last thread tab still releases the remaining Chromium context after 15 idle minutes', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  const { session } = fake.session(owner);
  await session.action({ kind: 'navigate', url: 'https://example.com' });
  const context = fake.contexts[0]!;

  await session.exec('closeTab', { index: 0 });
  assert.equal(session.isRunning(), false);
  assert.equal(context.closed, false);
  assert.equal(context.pages().length, 1, 'the keeper page remains open');
  t.mock.timers.tick(idleMs - 1);
  assert.equal(context.closeCalls, 0);
  t.mock.timers.tick(1);
  await settled(() => context.closed && !owner.isClosing);
  assert.equal(context.closeCalls, 1);
  assert.equal(context.pages().length, 0);
});

test('manual navigation and Agent browser tools both restart the idle countdown', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  const { session } = fake.session(owner);
  await session.action({ kind: 'navigate', url: 'https://example.com' });
  const context = fake.contexts[0]!;

  t.mock.timers.tick(idleMs - 1);
  await session.action({ kind: 'navigate', url: 'https://example.com/next' });
  t.mock.timers.tick(idleMs - 1);
  assert.equal(context.closeCalls, 0);
  await session.exec('tabs', {});
  t.mock.timers.tick(idleMs - 1);
  assert.equal(context.closeCalls, 0);
  t.mock.timers.tick(1);
  await settled(() => context.closed && !owner.isClosing);
});

test('state reads and frame capture do not keep an idle browser alive', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  const { session, driver } = fake.session(owner);
  await session.action({ kind: 'navigate', url: 'https://example.com' });
  const context = fake.contexts[0]!;

  t.mock.timers.tick(idleMs - 1);
  assert.equal((await session.state()).status, 'ready');
  assert.ok((await driver.capture()).data);
  t.mock.timers.tick(1);
  await settled(() => context.closed && !owner.isClosing);
});

test('operations in either thread protect the shared browser until all operations finish', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  await owner.acquire('first');
  await owner.acquire('second');
  assert.equal(fake.contexts.length, 1);
  const context = fake.contexts[0]!;
  const first = deferred();
  const second = deferred();
  const activeFirst = owner.withActivity(() => first.promise);
  const activeSecond = owner.withActivity(() => second.promise);

  t.mock.timers.tick(idleMs * 2);
  assert.equal(context.closeCalls, 0);
  first.resolve();
  await activeFirst;
  t.mock.timers.tick(idleMs * 2);
  assert.equal(context.closeCalls, 0);
  second.resolve();
  await activeSecond;
  t.mock.timers.tick(idleMs - 1);
  assert.equal(context.closeCalls, 0);
  t.mock.timers.tick(1);
  await settled(() => context.closed && !owner.isClosing);
});

test('a failed browser operation still starts a fresh idle countdown', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  await owner.acquire('thread');
  const context = fake.contexts[0]!;
  t.mock.timers.tick(idleMs - 1);
  await assert.rejects(
    owner.withActivity(async () => {
      throw new Error('Navigation failed');
    }),
    /Navigation failed/,
  );
  t.mock.timers.tick(idleMs - 1);
  assert.equal(context.closeCalls, 0);
  t.mock.timers.tick(1);
  await settled(() => context.closed && !owner.isClosing);
});

test('activity in one user or project does not extend another browser lifetime', async (t) => {
  const fake = await fixture(t);
  const owners = [
    fake.owner('alice'),
    fake.owner('alice', 'project'),
    fake.owner('bob'),
  ];
  for (const owner of owners) await owner.acquire('thread');
  t.mock.timers.tick(idleMs - 1);
  await owners[1]!.withActivity(async () => {});
  t.mock.timers.tick(1);
  await settled(
    () =>
      fake.contexts[0]!.closed &&
      fake.contexts[2]!.closed &&
      !owners[0]!.isClosing &&
      !owners[2]!.isClosing,
  );
  assert.equal(fake.contexts[1]!.closeCalls, 0);
  t.mock.timers.tick(idleMs - 1);
  await settled(() => fake.contexts[1]!.closed && !owners[1]!.isClosing);
});

test('an old operation finishing after close cannot delay a reopened browser timeout', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  const { session } = fake.session(owner);
  await session.action({ kind: 'navigate', url: 'https://example.com' });
  const held = deferred();
  const oldOperation = owner.withActivity(() => held.promise);
  await session.action({ kind: 'close' });
  assert.equal(fake.contexts[0]!.closed, true);
  await session.action({ kind: 'navigate', url: 'https://example.com/reopen' });
  const reopened = fake.contexts[1]!;
  t.mock.timers.tick(idleMs - 1);
  held.resolve();
  await oldOperation;
  assert.equal(reopened.closeCalls, 0);
  t.mock.timers.tick(1);
  await settled(() => reopened.closed && !owner.isClosing);
});

test('an unexpected browser disconnect clears the idle timer before reopening', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  await owner.acquire('thread');
  const old = fake.contexts[0]!;
  t.mock.timers.tick(idleMs - 1);
  await old.close();
  await owner.acquire('thread');
  const reopened = fake.contexts[1]!;
  t.mock.timers.tick(1);
  assert.equal(reopened.closeCalls, 0);
  t.mock.timers.tick(idleMs - 1);
  await settled(() => reopened.closed && !owner.isClosing);
});

test('idle shutdown retries after the browser initially refuses to close', async (t) => {
  const fake = await fixture(t);
  const owner = fake.owner();
  await owner.acquire('thread');
  const context = fake.contexts[0]!;
  context.failClose = true;
  t.mock.timers.tick(idleMs);
  await settled(() => context.closeCalls === 1 && !owner.isClosing);
  assert.equal(context.closed, false);
  context.failClose = false;
  t.mock.timers.tick(idleMs);
  await settled(() => context.closed && !owner.isClosing);
  assert.equal(context.closeCalls, 2);
});
