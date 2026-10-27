/** Exercise real Web Audio and the production notification provider, without a backend. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = path.join(root, 'apps/web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const serverRequire = createRequire(
  path.join(root, 'apps/server/package.json'),
);
const load = (name) => import(pathToFileURL(webRequire.resolve(name)).href);
const [
  { createServer },
  { default: react },
  { default: tailwindcss },
  { default: playwright },
] = await Promise.all([
  load('vite'),
  load('@vitejs/plugin-react'),
  load('@tailwindcss/vite'),
  import(pathToFileURL(serverRequire.resolve('playwright-core')).href),
]);

test(
  'signal notifications: acknowledgement, direction, responsive layout, sound preview, deduplication and cleanup',
  { timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(
      path.join(webRoot, '.notification-sound-test-'),
    );
    let vite, browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    await writeFile(
      path.join(fixture, 'auth.ts'),
      `import {createContext} from 'react';export const SessionContext=createContext(null);export const useAuthSession=()=>{const user=new URLSearchParams(location.search).get('user')??'alice';return {data:{user:{id:user},session:{id:'session-'+user}}};};`,
    );
    await writeFile(
      path.join(fixture, 'events.ts'),
      `
export class SharedEventSource extends EventTarget {
  closed=false;constructor(){super();(window.sources??=[]).push(this);}
  close(){this.closed=true;}
}
window.deliver=value=>{for(const source of window.sources??[])if(!source.closed)source.dispatchEvent(new MessageEvent('notification',{data:JSON.stringify(value)}));};`,
    );
    await writeFile(
      path.join(fixture, 'index.html'),
      '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>',
    );
    await writeFile(
      path.join(fixture, 'entry.tsx'),
      `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {Toaster} from 'sonner';
import {initializeI18n,i18n} from '/src/i18n';import '/src/index.css';
import {NotificationProvider} from '/src/features/notifications/notification-provider';
import {StrategyNotificationSettings} from '/@fs/${root}/plugins/vibe-quant/web/signals/notification-settings.tsx';
import {strategyNotifications} from '/@fs/${root}/plugins/vibe-quant/strategy-notifications.ts';
await initializeI18n();window.testI18n=i18n;
function App(){const[online,setOnline]=useState(true);const[value,setValue]=useState(()=>strategyNotifications(JSON.parse(localStorage.getItem('test-sound-settings')??'null')??{channels:{future:{enabled:true,option:'keep'}}}));
return <main className="mx-auto max-w-lg p-5">{online&&<NotificationProvider/>}<Toaster position="top-center" closeButton/>
<button onClick={()=>setOnline(false)}>退出测试账号</button>
<StrategyNotificationSettings value={value} onChange={next=>{setValue(next);localStorage.setItem('test-sound-settings',JSON.stringify(next));}}/>
</main>;}
createRoot(document.getElementById('root')!).render(<App/>);`,
    );
    vite = await createServer({
      configFile: false,
      envFile: false,
      root: webRoot,
      cacheDir: path.join(root, '.tmp/notification-sound-vite'),
      resolve: {
        alias: [
          {
            find: '@/features/auth/session-context',
            replacement: path.join(fixture, 'auth.ts'),
          },
          {
            find: '@/components/realtime/event-source',
            replacement: path.join(fixture, 'events.ts'),
          },
          { find: '@', replacement: path.join(webRoot, 'src') },
        ],
        dedupe: ['react', 'react-dom'],
      },
      optimizeDeps: { entries: [path.join(fixture, 'index.html')] },
      plugins: [react(), tailwindcss()],
      server: {
        watch: null,
        host: '127.0.0.1',
        port: 0,
        fs: { allow: [root] },
      },
    });
    await vite.listen();
    const port = vite.httpServer.address().port;
    const base = `http://127.0.0.1:${port}/${path.basename(fixture)}/index.html`;
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--autoplay-policy=user-gesture-required'],
    });
    const context = await browser.newContext({ locale: 'zh-CN' });
    const errors = [];
    context.on('page', (page) =>
      page.on('pageerror', (error) => {
        errors.push(error.message);
        t.diagnostic(error.stack);
      }),
    );
    await context.addInitScript(() => {
      window.activeSoundLocks = 0;
      if (navigator.locks) {
        const request = navigator.locks.request.bind(navigator.locks);
        navigator.locks.request = async (...args) => {
          window.activeSoundLocks++;
          try {
            return await request(...args);
          } finally {
            window.activeSoundLocks--;
          }
        };
      }
      window.tones = [];
      window.toneStarts = [];
      window.toneStops = [];
      window.waveforms = [];
      window.audioContexts = [];
      window.gains = [];
      const Native = window.AudioContext;
      if (!Native) return;
      window.AudioContext = class extends Native {
        constructor(...args) {
          super(...args);
          window.audioContexts.push(this);
        }
        createOscillator() {
          const node = super.createOscillator();
          const original = node.frequency.setValueAtTime.bind(node.frequency);
          node.frequency.setValueAtTime = (value, at) => {
            window.tones.push(value);
            window.toneStarts.push(at);
            return original(value, at);
          };
          const stop = node.stop.bind(node);
          node.stop = (at) => {
            window.toneStops.push(at);
            window.waveforms.push(node.type);
            return stop(at);
          };
          return node;
        }
        createGain() {
          const node = super.createGain();
          const original = node.gain.exponentialRampToValueAtTime.bind(
            node.gain,
          );
          node.gain.exponentialRampToValueAtTime = (value, at) => {
            window.gains.push(value);
            return original(value, at);
          };
          return node;
        }
      };
    });
    await context.route('**/api/rpc/notifications/config', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ json: { publicKey: null } }),
      }),
    );
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForFunction(() =>
      window.sources?.some((source) => !source.closed),
    );
    let cursor = 0;
    const event = (id, sound, toast = false, age = 0) => ({
      type: 'notification',
      cursor: String(++cursor),
      notification: {
        kind: 'plugin',
        id,
        pluginId: 'vibe-quant',
        title: '声音验证 ' + id,
        body: '测试信号',
        createdAt: new Date(Date.now() - age).toISOString(),
        url: '/plugins/vibe-quant/',
        toast,
        ...(sound ? { sound } : {}),
      },
    });
    await page.evaluate(
      (value) => window.deliver(value),
      event('locked', 'entry'),
    );
    await page.getByText('浏览器尚未启用提示音', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.tones.length), 0);
    await page.getByRole('button', { name: '启用声音', exact: true }).click();
    await page.waitForFunction(
      () => window.audioContexts[0]?.state === 'running',
    );
    await page.getByRole('switch', { name: '提示音', exact: true }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('test-sound-settings')).channels.sound
          .enabled,
    );
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('test-sound-settings')).channels
            .future.option,
      ),
      'keep',
    );
    await page.getByRole('button', { name: '试听入场', exact: true }).click();
    await page.waitForFunction(() => window.tones.length === 6);
    assert.deepEqual(
      await page.evaluate(() => window.tones),
      [660, 880, 660, 880, 660, 880],
    );
    assert.ok(
      await page.evaluate(
        () => window.toneStops[5] - window.toneStarts[0] >= 1.8,
      ),
    );
    assert.ok(
      await page.evaluate(() =>
        window.waveforms.every((type) => type === 'triangle'),
      ),
    );
    await page.getByRole('button', { name: '试听离场', exact: true }).click();
    await page.waitForFunction(() => window.tones.length === 12);
    assert.deepEqual(
      await page.evaluate(() => window.tones.slice(-6)),
      [880, 660, 880, 660, 880, 660],
    );
    await page.waitForFunction(
      () =>
        window.audioContexts[0].currentTime >= Math.max(...window.toneStops),
    );
    await page.evaluate(
      (value) => window.deliver(value),
      event('only-audio', 'entry'),
    );
    await page.waitForFunction(() => window.tones.length === 18);
    assert.equal(
      await page.getByText('声音验证 only-audio', { exact: true }).count(),
      0,
    );
    await page.evaluate(
      (value) => window.deliver(value),
      event('only-audio', 'entry'),
    );
    await page.evaluate(
      (value) => window.deliver(value),
      event('stale', 'exit', false, 60000),
    );
    await page.evaluate(
      (value) => window.deliver(value),
      event('toast-only', undefined, true),
    );
    await page.getByText('声音验证 toast-only', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.tones.length), 18);
    const legacyToast = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: '声音验证 toast-only' });
    assert.equal(await legacyToast.getAttribute('data-dismissible'), 'false');
    assert.equal(await legacyToast.locator('[data-close-button]').count(), 0);
    await legacyToast
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await legacyToast.waitFor({ state: 'hidden', timeout: 3000 });

    const showSignal = async (id, type, side, overrides = {}) => {
      const value = event(id, undefined, true);
      value.notification.marketSignal = {
        type,
        side,
        strategyName: '开盘区间突破策略',
        version: 3,
        symbol: 'CFFEX.IM2611',
        time: Date.parse('2026-10-27T09:31:00+08:00') / 1000,
        price: 6588.2,
        reason: '价格突破开盘区间',
        ...overrides,
      };
      await page.evaluate((value) => window.deliver(value), value);
      const card = page.locator('[data-sonner-toast]').filter({
        has: page.getByRole('region', {
          name: '声音验证 ' + id,
          exact: true,
        }),
      });
      await card.waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-sonner-toast][data-front="true"]')
            ?.getAttribute('data-mounted') === 'true',
      );
      // Wait for the entrance transition before measuring the card on mobile.
      await card.getByRole('button', { name: '确认', exact: true }).hover();
      return card;
    };
    const entryToast = await showSignal('long-entry', 'entry', 'long');
    await entryToast
      .getByRole('heading', { name: '入场信号', exact: true })
      .waitFor();
    assert.match(
      await entryToast.getByText('多头', { exact: true }).getAttribute('class'),
      /text-red-700/,
    );
    await entryToast.getByText('开盘区间突破策略', { exact: false }).waitFor();
    await entryToast.getByText('CFFEX.IM2611', { exact: true }).waitFor();
    // Beyond both the old 10s lifetime and Sonner's default, without hovering.
    await page.mouse.move(5, 700);
    await page.waitForTimeout(11000);
    assert.equal(await entryToast.isVisible(), true);
    await page.evaluate(() => window.testI18n.changeLanguage('en'));
    await entryToast
      .getByRole('heading', { name: 'Entry signal', exact: true })
      .waitFor();
    await page.evaluate(() => window.testI18n.changeLanguage('zh-CN'));
    await entryToast
      .getByRole('heading', { name: '入场信号', exact: true })
      .waitFor();
    await page.keyboard.press('Escape');
    const bounds = await entryToast.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 180, {
      steps: 8,
    });
    await page.mouse.up();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    assert.equal(await entryToast.getAttribute('data-removed'), 'false');
    await entryToast.getByRole('button', { name: '确认', exact: true }).click();
    await entryToast.waitFor({ state: 'hidden' });

    const exitToast = await showSignal('short-exit', 'exit', 'short');
    await exitToast
      .getByRole('heading', { name: '离场信号', exact: true })
      .waitFor();
    assert.match(
      await exitToast.getByText('空头', { exact: true }).getAttribute('class'),
      /text-emerald-800/,
    );
    await page.screenshot({
      path: path.join(root, '.tmp/notification-signal-desktop.png'),
      animations: 'disabled',
    });
    await exitToast.getByRole('button', { name: '确认', exact: true }).click();
    await exitToast.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 740 });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    const mobileToast = await showSignal('mobile', 'entry', 'short', {
      strategyName: '很长的策略名称'.repeat(6),
      price: 0,
      reason: '触发原因'.repeat(100),
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const mobileConfirm = await mobileToast
      .getByRole('button', { name: '确认', exact: true })
      .boundingBox();
    assert(
      mobileConfirm.y >= 0 && mobileConfirm.y + mobileConfirm.height <= 740,
    );
    await page.screenshot({
      path: path.join(root, '.tmp/notification-signal-mobile-dark.png'),
      animations: 'disabled',
    });
    await mobileToast
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await mobileToast.waitFor({ state: 'hidden' });
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('switch', { name: '提示音', exact: true }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('test-sound-settings')).channels.sound
          .enabled === false,
    );
    await page.reload();
    await page.getByRole('switch', { name: '提示音', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('switch', { name: '提示音', exact: true })
        .getAttribute('aria-checked'),
      'false',
    );
    await page.getByRole('switch', { name: '提示音', exact: true }).click();
    await page.waitForFunction(
      () => window.audioContexts[0]?.state === 'running',
    );
    const second = await context.newPage();
    await second.goto(base);
    await second.getByRole('button', { name: '试听入场', exact: true }).click();
    await second.waitForFunction(() => window.tones.length === 6);
    const shared = event('same-across-tabs', 'exit');
    await Promise.all([
      page.evaluate((value) => window.deliver(value), shared),
      second.evaluate((value) => window.deliver(value), shared),
    ]);
    await Promise.all([
      page.waitForFunction(() =>
        JSON.parse(
          localStorage.getItem('notification-sounds:alice') ?? '[]',
        ).some(([id]) => id === 'same-across-tabs'),
      ),
      second.waitForFunction(() =>
        JSON.parse(
          localStorage.getItem('notification-sounds:alice') ?? '[]',
        ).some(([id]) => id === 'same-across-tabs'),
      ),
    ]);
    await Promise.all(
      [page, second].map((tab) =>
        tab.waitForFunction(() => window.activeSoundLocks === 0),
      ),
    );
    assert.equal(
      (await page.evaluate(() => window.tones.length)) +
        (await second.evaluate(() => window.tones.length)),
      12,
      'one six-note alert across both tabs',
    );
    const locked = await context.newPage();
    await locked.goto(base);
    await locked.waitForFunction(() =>
      window.sources?.some((source) => !source.closed),
    );
    const fallback = event('locked-tab-does-not-claim', 'entry');
    await locked.evaluate((value) => window.deliver(value), fallback);
    await locked.getByText('浏览器尚未启用提示音', { exact: true }).waitFor();
    const previous = await second.evaluate(() => window.tones.length);
    await second.evaluate((value) => window.deliver(value), fallback);
    await second.waitForFunction(
      (count) => window.tones.length === count + 6,
      previous,
    );
    assert.equal(await locked.evaluate(() => window.tones.length), 0);
    await locked.close();
    const bob = await context.newPage();
    await bob.goto(base + '?user=bob');
    await bob.getByRole('button', { name: '试听入场', exact: true }).click();
    await bob.evaluate((value) => window.deliver(value), {
      ...shared,
      cursor: String(++cursor),
    });
    await bob.waitForFunction(() => window.tones.length === 12);
    assert.ok(
      await bob.evaluate(
        () =>
          window.gains.every((value) => value > 0 && value <= 0.24) &&
          window.gains.includes(0.24),
      ),
    );
    await bob
      .getByRole('button', { name: '退出测试账号', exact: true })
      .click();
    await bob.waitForFunction(() =>
      window.audioContexts.every((audio) => audio.state === 'closed'),
    );
    await bob.evaluate(
      (value) => window.deliver(value),
      event('after-logout', 'entry'),
    );
    assert.equal(await bob.evaluate(() => window.tones.length), 12);
    await page.bringToFront();
    await page.setViewportSize({ width: 390, height: 740 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(root, '.tmp/notification-sound-settings.png'),
      fullPage: true,
    });
    const unsupported = await context.newPage();
    await unsupported.addInitScript(() => {
      window.AudioContext = undefined;
      window.webkitAudioContext = undefined;
    });
    await unsupported.goto(base);
    await unsupported
      .getByText('当前浏览器不支持页面提示音。', { exact: true })
      .waitFor();
    assert.equal(
      await unsupported
        .getByRole('button', { name: '试听入场', exact: true })
        .isDisabled(),
      true,
    );
    await unsupported
      .getByRole('switch', { name: '提示音', exact: true })
      .click();
    await unsupported
      .getByRole('switch', { name: '提示音', exact: true })
      .isDisabled()
      .then((value) => assert.equal(value, true));
    assert.deepEqual(errors, []);
  },
);
