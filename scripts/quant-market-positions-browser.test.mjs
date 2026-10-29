/** Exercise the actual market page and positions polling with isolated API fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
const start = Date.parse('2026-10-29T09:30:00+08:00') / 1000;
const watchlist = ['CFFEX.IM2611', 'SSE.000852'].map((symbol, index) => ({
  symbol,
  name: index ? '中证1000' : '中证1000期货',
  kind: index ? 'index' : 'future',
  priceTick: 0.2,
  enabled: true,
}));
const monitors = ['突破策略', '趋势跟随策略'].map((name, index) => ({
  id: `m${index}`,
  strategy_id: `s${index}`,
  strategy_name: name,
  engine: 'tqsdk',
  version_number: index + 1,
  enabled: !index,
  notifications_enabled: !index,
  status: index ? 'paused' : 'running',
  config: {
    symbol: watchlist[index].symbol,
    display_symbol: watchlist[0].symbol,
    duration: 60,
    execution_model: index ? 'points' : 'actual_contract',
  },
  through: start + 600,
  replaying: false,
}));
monitors.push({
  ...monitors[0],
  id: 'm2',
  strategy_id: 's2',
  strategy_name: '均值回归策略',
  config: {
    ...monitors[0].config,
    symbol: 'SHFE.rb2701',
    display_symbol: 'SHFE.rb2701',
  },
  status: 'error',
  notifications_enabled: false,
  message: '行情数据暂不可用',
  through: null,
});
const trade = (index, open = false) => ({
  id: `t${index}`,
  status: open ? 'open' : 'closed',
  symbol: watchlist[index % 2].symbol,
  side: index % 2 ? 'short' : 'long',
  quantity: 1,
  entry_time: start - index * 60,
  entry_price: 7000.2,
  exit_time: open ? null : start + 120,
  exit_price: open ? null : 7045.2,
  net_pnl: open ? null : 45,
  fees: 0,
  observed_until: start + 600,
  exit_reason: 'take_profit',
});

test(
  'market positions: all symbols, pagination, polling, failures, book and responsive layout',
  { timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(
      path.join(webRoot, '.quant-market-positions-test-'),
    );
    const artifacts = path.join(root, '.tmp/quant-market-positions');
    await mkdir(artifacts, { recursive: true });
    let vite, browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    await writeFile(
      path.join(fixture, 'index.html'),
      '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>',
    );
    await writeFile(
      path.join(fixture, 'entry.tsx'),
      `
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/index.css';
import {initializeI18n} from '/src/i18n';await initializeI18n();
import {MarketPage} from '/@fs/${root}/plugins/vibe-quant/web/market-page.tsx';
createRoot(document.getElementById('root')!).render(<main className="p-4 sm:ml-56"><MarketPage pluginId="vibe-quant"/></main>);`,
    );
    vite = await createServer({
      configFile: false,
      envFile: false,
      root: webRoot,
      cacheDir: path.join(artifacts, 'vite'),
      resolve: {
        alias: [{ find: '@', replacement: path.join(webRoot, 'src') }],
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
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      locale: 'zh-CN',
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error(error.stack);
    });
    let failed = false,
      empty = false,
      count = 6,
      queries = [];
    await page.route('**/api/plugins/vibe-quant/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/monitors/positions')) {
        queries.push(url.search);
        if (failed)
          return route.fulfill({
            status: 503,
            json: { code: 'STRATEGY_SERVICE_UNAVAILABLE' },
          });
        return route.fulfill({
          json: {
            monitors: empty ? [] : monitors,
            open: empty
              ? []
              : Array.from({ length: count }, (_, index) => ({
                  monitor_id: `m${index % 2}`,
                  trade: trade(index, true),
                })),
            history: empty
              ? []
              : Array.from({ length: url.search ? 1 : 50 }, (_, index) => ({
                  monitor_id: `m${index % 2}`,
                  trade: trade(index + (url.search ? 50 : 0)),
                })),
            next: url.search || empty ? null : 'older-cursor',
          },
        });
      }
      if (url.pathname.endsWith('/watchlist'))
        return route.fulfill({ json: watchlist });
      if (url.pathname.endsWith('/snapshot'))
        return route.fulfill({
          json: {
            status: { engine: 'tqsdk', state: 'syncing' },
            quotes: [],
            orderBooks: [],
          },
        });
      if (url.pathname.endsWith('/bars'))
        return route.fulfill({
          json: Array.from({ length: 120 }, (_, index) => ({
            symbol: url.searchParams.get('symbol'),
            duration: 60,
            time: start + index * 60,
            open: 7000 + index,
            high: 7002 + index,
            low: 6998 + index,
            close: 7001 + index,
            volume: 1000,
          })),
        });
      return route.fulfill({ json: [] });
    });
    await page.goto(
      `http://127.0.0.1:${vite.httpServer.address().port}/${path.basename(fixture)}/index.html`,
      { timeout: 60000, waitUntil: 'domcontentloaded' },
    );
    const sidebar = page.getByRole('complementary', { name: '策略持仓与行情' });
    const list = sidebar.getByRole('list', { name: '持仓记录列表' });
    const current = list.getByRole('listitem').filter({ hasText: '持仓中' });
    const history = list.getByRole('listitem').filter({ hasText: '已平仓' });
    await current.nth(5).waitFor();
    assert.equal(
      await current.getByText('CFFEX.IM2611', { exact: true }).count(),
      6,
    );
    assert.equal(
      await current.getByText('SSE.000852', { exact: true }).count(),
      3,
    );
    await history.nth(49).waitFor();
    assert.equal(await list.getByRole('listitem').count(), 56);
    assert.match(await list.getByRole('listitem').nth(5).innerText(), /持仓中/);
    assert.match(await list.getByRole('listitem').nth(6).innerText(), /已平仓/);
    const viewport = sidebar
      .getByRole('tabpanel', { name: '持仓记录' })
      .locator('[data-slot="scroll-area-viewport"]');
    await viewport.evaluate((element) => {
      element.scrollTop = 320;
    });
    await sidebar.getByRole('button', { name: '刷新策略持仓' }).click();
    await page.waitForResponse((response) =>
      response.url().endsWith('/monitors/positions'),
    );
    assert.equal(
      await viewport.evaluate((element) => element.scrollTop),
      320,
      'refresh preserves scroll',
    );
    await sidebar.getByRole('button', { name: '更早持仓' }).click();
    await sidebar.getByText('历史第 2 页').waitFor();
    await page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll('[aria-label="持仓记录列表"] > li'),
        ].filter((row) => row.textContent.includes('已平仓')).length === 1,
    );
    assert.equal(
      await current.count(),
      6,
      'older history retains current holdings at the top',
    );
    assert(
      await sidebar.getByRole('button', { name: '更早持仓' }).isDisabled(),
    );
    await sidebar.getByRole('button', { name: '刷新策略持仓' }).click();
    await page.waitForResponse((response) =>
      response.url().includes('before=older-cursor'),
    );
    assert.equal(await sidebar.getByText('历史第 2 页').count(), 1);
    assert(queries.at(-1).includes('before=older-cursor'));
    await sidebar
      .getByRole('button', { name: '最新历史', exact: true })
      .click();
    await history.nth(49).waitFor();
    await page.screenshot({
      path: path.join(artifacts, 'history-desktop.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: /中证1000 SSE.000852/ }).click();
    assert.equal(
      await current.count(),
      6,
      'changing the chart retains other symbols',
    );
    await sidebar.getByRole('tab', { name: /已加载策略/ }).click();
    const strategies = sidebar.getByRole('list', { name: '已加载策略列表' });
    assert.equal(await strategies.getByRole('listitem').count(), 3);
    await strategies.getByText('已暂停', { exact: true }).waitFor();
    await strategies.getByText('异常', { exact: true }).waitFor();
    const withoutPositions = strategies
      .getByRole('listitem')
      .filter({ hasText: '均值回归策略' });
    await withoutPositions.getByText('SHFE.rb2701', { exact: true }).waitFor();
    await withoutPositions.getByText('0 笔', { exact: true }).waitFor();
    await withoutPositions.getByText('已关闭', { exact: true }).waitFor();
    await withoutPositions
      .getByText('行情数据暂不可用', { exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(artifacts, 'strategies-desktop.png'),
      fullPage: true,
    });
    await sidebar.getByRole('tab', { name: '持仓记录', exact: true }).click();
    count = 1;
    await sidebar.getByRole('button', { name: '刷新策略持仓' }).click();
    await page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll('[aria-label="持仓记录列表"] > li'),
        ].filter((row) => row.textContent.includes('持仓中')).length === 1,
    );
    failed = true;
    await sidebar.getByRole('button', { name: '刷新策略持仓' }).click();
    await sidebar.getByRole('alert').filter({ visible: true }).waitFor();
    assert.equal(
      await current.count(),
      1,
      'failed polling keeps last good snapshot',
    );
    await sidebar.getByRole('tab', { name: /已加载策略/ }).click();
    await sidebar
      .getByRole('alert')
      .getByText(/策略更新失败/)
      .waitFor();
    assert.equal(
      await strategies.getByRole('listitem').count(),
      3,
      'strategy list retains the last snapshot on failure',
    );
    failed = false;
    await sidebar
      .getByRole('button', { name: '重试策略加载' })
      .filter({ visible: true })
      .click();
    await sidebar
      .getByRole('alert')
      .filter({ visible: true })
      .waitFor({ state: 'hidden' });
    await sidebar.getByRole('tab', { name: '持仓记录', exact: true }).click();
    await page.screenshot({
      path: path.join(artifacts, 'current-desktop.png'),
      fullPage: true,
    });
    await sidebar.getByRole('tab', { name: '行情盘口', exact: true }).click();
    await sidebar.getByRole('region', { name: '买卖盘口' }).waitFor();
    await sidebar.getByRole('tab', { name: '持仓记录', exact: true }).click();
    for (const width of [1280, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `no horizontal overflow at ${width}px`,
      );
      await page.screenshot({
        path: path.join(artifacts, `current-${width}.png`),
        fullPage: true,
      });
      await sidebar.getByRole('tab', { name: /已加载策略/ }).click();
      assert.equal(await strategies.getByRole('listitem').count(), 3);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `strategy list has no horizontal overflow at ${width}px`,
      );
      await page.screenshot({
        path: path.join(artifacts, `strategies-${width}.png`),
        fullPage: true,
      });
      await sidebar.getByRole('tab', { name: '持仓记录', exact: true }).click();
    }
    empty = true;
    await sidebar.getByRole('button', { name: '刷新策略持仓' }).click();
    await sidebar
      .getByText('尚未添加策略', { exact: true })
      .filter({ visible: true })
      .waitFor();
    await sidebar.getByRole('tab', { name: /已加载策略/ }).click();
    await sidebar
      .getByText('尚未添加策略', { exact: true })
      .filter({ visible: true })
      .waitFor();
    assert.deepEqual(errors, []);
  },
);
