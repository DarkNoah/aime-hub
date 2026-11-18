import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { imageSize } from 'image-size';
import { ThreadBrowsers } from './browser/registry.js';
import { ThreadBrowserSession, type BrowserDriver } from './browser/session.js';
import type { BrowserExecBinding } from './browser/exec-actions.js';
import { chatBrowserLaunchOptions } from './browser/user-browser.js';
import type { ThreadBrowser } from './browser.js';

test('chat Chromium defaults to headless in development and headed in production', () => {
  const launcher = '/usr/local/bin/chat-chromium-xvfb';
  const development = {
    NODE_ENV: 'development',
    DISPLAY: ':0',
    CHAT_BROWSER_HEADED_EXECUTABLE: launcher,
  };
  const production = {
    NODE_ENV: 'production',
    CHAT_BROWSER_HEADED_EXECUTABLE: launcher,
  };
  const native = chatBrowserLaunchOptions({});
  const headed = { headless: false, executablePath: launcher };

  assert.equal(native.headless, true);
  assert.deepEqual(chatBrowserLaunchOptions(development), native);
  assert.equal(chatBrowserLaunchOptions({ NODE_ENV: 'test' }).headless, true);
  assert.deepEqual(chatBrowserLaunchOptions(production), headed);
  assert.equal(
    chatBrowserLaunchOptions({ NODE_ENV: 'production' }).headless,
    false,
  );
  assert.deepEqual(
    chatBrowserLaunchOptions({ ...production, CHAT_BROWSER_HEADLESS: 'true' }),
    native,
  );
  assert.deepEqual(
    chatBrowserLaunchOptions({
      ...development,
      CHAT_BROWSER_HEADLESS: 'false',
    }),
    headed,
  );
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

    const resize = { kind: 'resize', width: 580, height: 840 } as const;
    const viewport = { script: '[window.innerWidth, window.innerHeight]' };
    await first('newTab', { url: pageUrl('before resize') });
    const initialFrame = deferred<void>();
    const resizedFrame = deferred<string>();
    const animatedFrame = deferred<string>();
    let animating = false;
    const stop = live.subscribe((event) => {
      if (event.type !== 'frame') return;
      initialFrame.resolve();
      if (
        event.frame.viewport.width === resize.width &&
        event.frame.viewport.height === resize.height
      ) {
        resizedFrame.resolve(event.frame.data);
        if (animating && 'pageScaleFactor' in event.frame.viewport)
          animatedFrame.resolve(event.frame.data);
      }
    });
    try {
      await initialFrame.promise;
      await live.action(resize);
      const still = imageSize(
        Buffer.from(await resizedFrame.promise, 'base64'),
      );
      assert.equal(still.type, 'jpg');
      assert.ok(
        Math.abs(still.width / still.height - resize.width / resize.height) <
          0.01,
      );
      assert.deepEqual(await first('evaluate', viewport), [580, 840]);
      const png = String(await first('screenshot', {}));
      const { width, height } = imageSize(
        Buffer.from(png.split(',')[1]!, 'base64'),
      );
      assert.deepEqual([width, height], [580, 840]);
      await first('evaluate', {
        script: "document.body.style.minHeight = '1400px'; true",
      });
      const full = String(await first('screenshot', { fullPage: true }));
      assert.ok(
        imageSize(Buffer.from(full.split(',')[1]!, 'base64')).height >= 1400,
      );
      animating = true;
      await first('evaluate', {
        script:
          'document.body.animate([{opacity: 1}, {opacity: 0}], {duration: 400, iterations: Infinity}); true',
      });
      const motion = imageSize(
        Buffer.from(await animatedFrame.promise, 'base64'),
      );
      assert.equal(motion.type, 'jpg');
      assert.ok(motion.height <= 720);
      assert.ok(
        Math.abs(motion.width / motion.height - resize.width / resize.height) <
          0.01,
      );
    } finally {
      stop();
    }
    await first('switchTab', { index: 0 });
    assert.deepEqual(await first('evaluate', viewport), [580, 840]);
    await first('newTab', { url: pageUrl('after resize') });
    assert.deepEqual(await first('evaluate', viewport), [580, 840]);
    const manager = await (live.browser as ThreadBrowser).getManagerForThread();
    const popup = manager.getPage().waitForEvent('popup');
    await first('evaluate', { script: 'window.open("about:blank"); true' });
    await (
      await popup
    ).waitForFunction(() => innerWidth === 580 && innerHeight === 840);
    assert.equal((await live.state()).tabs.length, 4);
    assert.deepEqual(await second('evaluate', viewport), [1280, 720]);
    await first('close', {});
    assert.deepEqual(await second('tabs', {}), []);
  },
);
