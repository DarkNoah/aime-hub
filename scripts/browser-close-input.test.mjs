import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const webRequire = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const { createServer } = await import(
  pathToFileURL(webRequire.resolve('vite')).href
);

test(
  'browser panel opens URLs before Agent use, retries failures and reopens after close',
  { timeout: 60000 },
  async (t) => {
    const serverRequire = createRequire(
      new URL('../apps/server/package.json', import.meta.url),
    );
    const [
      { default: react },
      { default: tailwindcss },
      { default: playwright },
    ] = await Promise.all([
      import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href),
      import(pathToFileURL(webRequire.resolve('@tailwindcss/vite')).href),
      import(pathToFileURL(serverRequire.resolve('playwright-core')).href),
    ]);
    const fixture = await mkdtemp(path.join(webRoot, '.browser-input-test-'));
    let vite, browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    await writeFile(
      path.join(fixture, 'entry.tsx'),
      `
import React from 'react';
import {createRoot} from 'react-dom/client';
import BrowserPanel from '/src/components/browser/panel';
import {SessionContext} from '/src/features/auth/session-context';
import {initializeI18n} from '/src/i18n';
import {Toaster} from 'sonner';
import '/src/index.css';
const blank = {status:'waiting',url:'',tabs:[],activeTabIndex:0,busy:false};
const sources = new Set();
const canvas = document.createElement('canvas');canvas.width=1280;canvas.height=720;
const ctx = canvas.getContext('2d');ctx.fillStyle='#f5f5f5';ctx.fillRect(0,0,1280,720);
ctx.fillStyle='#162e24';ctx.font='32px sans-serif';ctx.fillText('Browser interaction fixture',40,60);
const frame = {data:canvas.toDataURL('image/jpeg').split(',')[1],viewport:{width:1280,height:720}};
window.fixture = {
  state:blank,sources,calls:[],failNext:false,holdNext:false,
  emit(type,data){for(const source of sources)source.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));},
  update(next){this.state={...this.state,...next};this.emit('state',this.state);if(this.state.status==='ready')this.emit('frame',frame);},
  async action(body){
    this.calls.push(body);
    if(body.kind==='navigate'){
      if(this.failNext){this.failNext=false;throw new Error('navigation failed');}
      if(this.holdNext){this.holdNext=false;await new Promise(resolve=>this.release=resolve);}
      this.update({status:'ready',url:body.url,tabs:[{url:body.url,title:'Page'}]});
    }
    if(body.kind==='close')this.update({...blank,status:'closed'});
  }
};
await initializeI18n();
createRoot(document.getElementById('root')).render(
  <SessionContext.Provider value={{data:{user:{id:'user'},session:{id:'session'}},isPending:false}}>
    <div style={{width:'min(100vw, 440px)',height:640}}><BrowserPanel threadId="thread" onClose={()=>{}}/></div><Toaster/>
  </SessionContext.Provider>
);`,
    );
    vite = await createServer({
      root: webRoot,
      configFile: false,
      envFile: false,
      cacheDir: path.join(fixture, 'node_modules/.vite'),
      resolve: {
        alias: { '@': path.join(webRoot, 'src') },
        dedupe: ['react', 'react-dom'],
      },
      plugins: [
        {
          name: 'browser-panel-fixture',
          enforce: 'pre',
          resolveId(id) {
            for (const module of [
              'lib/rpc',
              'components/realtime/event-source',
            ]) {
              if (
                id === `@/${module}` ||
                id === path.join(webRoot, 'src', module)
              )
                return '\0@/' + module;
            }
          },
          load(id) {
            if (id === '\0@/lib/rpc')
              return `export const api={threads:{browser:{state:async()=>window.fixture.state,action:async({body})=>window.fixture.action(body)}}};export const apiErrorCode=error=>error?.code;`;
            if (id === '\0@/components/realtime/event-source')
              return `export class SharedEventSource extends EventTarget {constructor(){super();window.fixture.sources.add(this);setTimeout(()=>window.fixture.emit('state',window.fixture.state),0);}close(){window.fixture.sources.delete(this);}}`;
          },
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (req.url !== '/') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await server.transformIndexHtml(
                  '/',
                  `<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/${path.basename(fixture)}/entry.tsx"></script></body></html>`,
                ),
              );
            });
          },
        },
        react(),
        tailwindcss(),
      ],
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 900, height: 720 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    const address = page.getByRole('textbox', {
      name: '输入网址',
      exact: true,
    });
    const open = page.getByRole('button', { name: '打开网页', exact: true });
    await page.getByText('待启动', { exact: true }).waitFor();
    assert.equal(await address.isEditable(), true);
    assert.equal(await open.isDisabled(), true);
    assert.equal(
      await page
        .getByRole('button', { name: '刷新网页', exact: true })
        .isDisabled(),
      true,
    );
    await address.fill('https://');
    await address.press('Enter');
    await page.getByText('请输入有效的浏览器地址。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
    await address.fill('example.com');
    await address.press('Enter');
    await page.getByText('运行中', { exact: true }).waitFor();
    assert.equal(await address.inputValue(), 'https://example.com/');
    const screen = page.getByLabel('浏览器实时画面', { exact: true });
    await screen.waitFor({ state: 'visible' });
    await screen.click();
    await page.keyboard.insertText('手动输入');
    await page.waitForFunction(() =>
      window.fixture.calls.some(
        (call) => call.kind === 'text' && call.text === '手动输入',
      ),
    );

    await page.evaluate(() => {
      window.fixture.failNext = true;
    });
    await address.fill('https://failed.example/');
    await open.click();
    await page.getByText('浏览器操作失败，请重试。', { exact: true }).waitFor();
    assert.equal(await address.inputValue(), 'https://failed.example/');
    assert.equal(await address.isEditable(), true);
    await page.evaluate(() => {
      window.fixture.holdNext = true;
    });
    await open.click();
    await page.getByText('正在打开…', { exact: true }).waitFor();
    assert.equal(await open.isDisabled(), true);
    await page.evaluate(() => window.fixture.release());
    await page.waitForFunction(
      () => document.querySelector('input').readOnly === false,
    );
    assert.equal(await address.inputValue(), 'https://failed.example/');

    await page.getByRole('switch', { name: '允许交互' }).click();
    await page
      .getByRole('button', {
        name: '结束浏览器：关闭你的所有线程页面，保留登录状态',
        exact: true,
      })
      .click();
    await page.getByText('已关闭', { exact: true }).waitFor();
    await page.getByRole('switch', { name: '允许交互' }).click();
    await address.fill('chrome://version');
    await open.click();
    await page.getByText('运行中', { exact: true }).waitFor();
    assert.equal(await address.inputValue(), 'chrome://version/');
    await page.evaluate(() => window.fixture.update({ busy: true }));
    await page.getByText('Agent 操作中', { exact: true }).waitFor();
    assert.equal(await address.isEditable(), true);
    assert.equal(await open.isDisabled(), false);
    assert.equal(
      await page.getByRole('switch', { name: '允许交互' }).isDisabled(),
      false,
    );
    await page.evaluate(() => {
      window.fixture.calls = [];
    });
    await screen.click();
    await page.keyboard.insertText('Agent 运行时输入');
    await page.keyboard.press('Enter');
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => {
      const calls = window.fixture.calls;
      return (
        calls.some(
          (call) => call.kind === 'text' && call.text === 'Agent 运行时输入',
        ) &&
        [
          'mousePressed',
          'mouseReleased',
          'mouseWheel',
          'keyDown',
          'keyUp',
        ].every((type) => calls.some((call) => call.event?.type === type))
      );
    });
    await address.fill('https://concurrent.example/');
    await address.press('Enter');
    await page.waitForFunction(
      () => window.fixture.state.url === 'https://concurrent.example/',
    );
    for (const name of ['刷新网页', '后退', '前进'])
      await page.getByRole('button', { name, exact: true }).click();
    await page.evaluate(() =>
      window.fixture.update({
        tabs: [
          { url: 'https://concurrent.example/', title: 'Current' },
          { url: 'https://second.example/', title: 'Second' },
        ],
      }),
    );
    await page.getByRole('button', { name: '切换标签页', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Second', exact: true }).click();
    await page.waitForFunction(() =>
      ['navigate', 'reload', 'back', 'forward', 'tab'].every((kind) =>
        window.fixture.calls.some((call) => call.kind === kind),
      ),
    );
    assert.equal(await page.evaluate(() => window.fixture.state.busy), true);
    await page.getByRole('switch', { name: '允许交互' }).click();
    assert.equal(await address.isEditable(), false);
    assert.equal(await page.locator('textarea').isDisabled(), true);
    await page.getByRole('switch', { name: '允许交互' }).click();
    assert.equal(await address.isEditable(), true);
    assert.equal(await page.locator('textarea').isDisabled(), false);
    await page.evaluate(() => window.fixture.update({ busy: false }));
    await page.getByText('运行中', { exact: true }).waitFor();
    for (const width of [360, 900]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForFunction(
        () => document.documentElement.scrollWidth <= innerWidth,
      );
      if (width === 360 && process.env.BROWSER_PANEL_SCREENSHOT)
        await page.screenshot({
          path: process.env.BROWSER_PANEL_SCREENSHOT.replace(
            '.png',
            '-narrow.png',
          ),
        });
    }
    if (process.env.BROWSER_PANEL_SCREENSHOT)
      await page.screenshot({ path: process.env.BROWSER_PANEL_SCREENSHOT });
    await page.evaluate(() => window.fixture.emit('revoked', {}));
    await page
      .getByText('会话已失效或已无权访问此浏览器。', { exact: true })
      .first()
      .waitFor();
    assert.equal(await address.isEditable(), false);
    assert.equal(await open.isDisabled(), true);
    assert.deepEqual(errors, []);
  },
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
