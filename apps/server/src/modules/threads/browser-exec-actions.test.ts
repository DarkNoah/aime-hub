import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadBrowsers } from './browser/registry.js';
import { ThreadBrowserSession, type BrowserDriver } from './browser/session.js';
import type { BrowserExecBinding } from './browser/exec-actions.js';
import { chatBrowserLaunchOptions } from './browser/user-browser.js';

test('chat Chromium selects the container display, native desktop or headless fallback', () => {
  const launcher = '/usr/local/bin/chat-chromium-xvfb';
  const containerEnv = { CHAT_BROWSER_HEADED_EXECUTABLE: launcher };
  const native = chatBrowserLaunchOptions({}, 'linux');
  assert.equal(native.headless, true);
  assert.deepEqual(chatBrowserLaunchOptions(containerEnv, 'linux'), {
    headless: false,
    executablePath: launcher,
  });
  assert.deepEqual(
    chatBrowserLaunchOptions(
      { ...containerEnv, CHAT_BROWSER_HEADLESS: 'true' },
      'linux',
    ),
    native,
  );
  assert.equal(
    chatBrowserLaunchOptions({ DISPLAY: ':0' }, 'linux').headless,
    false,
  );
  assert.equal(
    chatBrowserLaunchOptions({ CHAT_BROWSER_HEADLESS: 'false' }, 'linux')
      .headless,
    false,
  );
  assert.equal(chatBrowserLaunchOptions({}, 'darwin').headless, false);
  assert.equal(chatBrowserLaunchOptions({}, 'win32').headless, false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function session(exec: BrowserExecBinding) {
  return new ThreadBrowserSession('thread', {
    browser: {
      hasThreadSession: () => true,
      isBrowserRunning: () => true,
    } as unknown as BrowserDriver['browser'],
    action: async () => {},
    capture: async () => {
      throw new Error('Unexpected capture');
    },
    exec,
  });
}

test('a canceled queued exec browser command returns immediately and never runs', async () => {
  const started = deferred<void>();
  const released = deferred<void>();
  const actions: string[] = [];
  const thread = session(async (operation) => {
    actions.push(operation);
    if (operation === 'wait') {
      started.resolve();
      await released.promise;
    }
  });
  const waiting = thread.exec('wait', {});
  await started.promise;
  const controller = new AbortController();
  const canceled = thread.exec('click', {}, controller.signal);
  const next = thread.exec('tabs', {});
  controller.abort(new Error('test canceled'));
  await assert.rejects(canceled, /test canceled/);
  assert.deepEqual(actions, ['wait']);
  released.resolve();
  await Promise.all([waiting, next]);
  assert.deepEqual(actions, ['wait', 'tabs']);
});

test('a manual close interrupts current and queued exec commands', async () => {
  const started = deferred<void>();
  const actions: string[] = [];
  const thread = session(async (operation, _input, signal) => {
    actions.push(operation);
    started.resolve();
    if (operation === 'wait')
      await new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
  });
  const waiting = thread.exec('wait', {});
  await started.promise;
  const queued = thread.exec('click', {});
  const interrupted = Promise.all([
    assert.rejects(waiting, /Browser closed/),
    assert.rejects(queued, /Browser closed/),
  ]);
  await thread.action({ kind: 'close' });
  await interrupted;
  await thread.exec('goto', {});
  assert.deepEqual(actions, ['wait', 'goto']);
});

test('only goto or newTab can create a thread browser', async (t) => {
  const browsers = new ThreadBrowsers('/unused', () => {
    throw new Error('Unexpected browser creation');
  });
  t.after(() => browsers.dispose());
  const exec = browsers.execForThread('thread', 'user', 'project');
  assert.deepEqual(await exec('tabs', {}), []);
  await exec('close', {});
  for (const operation of [
    'snapshot',
    'screenshot',
    'fill',
    'click',
    'evaluate',
    'switchTab',
    'closeTab',
  ])
    await assert.rejects(exec(operation, {}), /BROWSER_NOT_RUNNING/);
  assert.equal(browsers.get('thread', 'user'), undefined);
});

test(
  'exec actions share the registered Chromium page with manual input and preview',
  {
    skip: process.env.BROWSER_INTEGRATION !== '1',
    timeout: 45000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'thread-browser-exec-'));
    const browsers = new ThreadBrowsers(root);
    t.after(async () => {
      await browsers.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const first = browsers.execForThread('first', 'user', 'project');
    const second = browsers.execForThread('second', 'user', 'project');
    const pageUrl = (name: string) =>
      'data:text/html,' +
      encodeURIComponent(
        `<title>${name}</title><input aria-label="Name"><button onclick="document.title='clicked'">Confirm</button>`,
      );
    const url = pageUrl('first');
    await Promise.all([
      first('goto', { url }),
      second('newTab', { url: pageUrl('second') }),
    ]);
    const snapshot = String(await first('snapshot', {}));
    const ref = /textbox "Name" (@e\d+)/.exec(snapshot)?.[1];
    assert.ok(ref, snapshot);
    await first('fill', { target: ref, value: 'exec' });
    const live = browsers.get('first', 'user')!;
    // Use the same action path as a user pasting into the focused field in the frontend.
    await live.action({ kind: 'text', text: ' + manual' });
    assert.equal(
      await first('evaluate', {
        script: 'document.querySelector("input").value',
      }),
      'exec + manual',
    );
    assert.equal(
      await second('evaluate', {
        script: 'document.querySelector("input").value',
      }),
      '',
    );
    await first('click', { target: 'button' });
    assert.equal(
      await first('evaluate', { script: 'document.title' }),
      'clicked',
    );
    assert.match(
      String(await first('screenshot', {})),
      /^data:image\/png;base64,iVBOR/,
    );

    const firstFrame = deferred<string>();
    const unsubscribe = live.subscribe((event) => {
      if (event.type === 'frame') firstFrame.resolve(event.frame.data);
    });
    try {
      assert.equal(
        Buffer.from(await firstFrame.promise, 'base64')
          .subarray(0, 2)
          .toString('hex'),
        'ffd8',
      );
    } finally {
      unsubscribe();
    }

    const cancelClick = new AbortController();
    const clicking = first('click', { target: '#later' }, cancelClick.signal);
    const canceled = assert.rejects(clicking, /test canceled/);
    await delay(100);
    cancelClick.abort(new Error('test canceled'));
    await canceled;
    await first('evaluate', {
      script: `const b = document.createElement('button'); b.id = 'later'; b.onclick = () => document.title = 'late click'; document.body.appendChild(b); true`,
    });
    await delay(900);
    assert.equal(
      await first('evaluate', { script: 'document.title' }),
      'clicked',
    );

    await first('evaluate', {
      script: `document.body.insertAdjacentHTML('beforeend', '<select><option value="blue">Blue</option></select><button id="confirm" onclick="confirm(123)">Ask</button>'); true`,
    });
    await first('wait', { target: 'select' });
    assert.deepEqual(
      await first('select', { target: 'select', value: 'blue' }),
      ['blue'],
    );
    await first('hover', { target: '#confirm' });
    assert.deepEqual(
      await first('dialog', { target: '#confirm', action: 'dismiss' }),
      { type: 'confirm', message: '123' },
    );

    await first('newTab', { url: pageUrl('additional') });
    assert.equal((await live.state()).activeTabIndex, 1);
    assert.equal(((await first('tabs', {})) as unknown[]).length, 2);
    assert.equal(((await second('tabs', {})) as unknown[]).length, 1);
    await first('switchTab', { index: 0 });
    await assert.rejects(
      first('click', { target: ref }),
      /Take a new snapshot/,
    );
    await first('closeTab', { index: 1 });
    assert.equal((await live.state()).tabs[0]?.url, url);
    await assert.rejects(
      browsers.execForThread('first', 'user', 'other')('tabs', {}),
      /scope mismatch/,
    );
    assert.deepEqual(
      await browsers.execForThread('first', 'another', 'project')('tabs', {}),
      [],
    );
    await first('close', {});
    assert.deepEqual(await second('tabs', {}), []);
  },
);
