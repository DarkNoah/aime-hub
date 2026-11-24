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
  unrealized_pnl: open ? 0 : undefined,
  mark_price: open ? 7000.2 : undefined,
  pnl_multiplier: index % 2 ? 1 : 200,
  fees: 0,
  observed_until: start + 600,
  exit_reason: 'take_profit',
});
const closedPositions = Array.from({ length: 53 }, (_, index) => ({
  monitor_id: `m${index % 2}`,
  trade: {
    ...trade(index),
    exit_time:
      index < 51 ? start + 120 : Date.parse('2026-09-30T15:00:00+08:00') / 1000,
    net_pnl: [120, -45, 0][index % 3],
    ...(index === 2 && {
      exit_reason: 'stop_loss',
      exit_note: '移动止损保本',
      pnl_override: 0,
    }),
  },
}));
function monthlySummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const month = new Date((row.trade.exit_time + 8 * 60 * 60) * 1000)
      .toISOString()
      .slice(0, 7);
    const unit = row.monitor_id === 'm1' ? 'points' : 'currency';
    const key = `${month}:${unit}`;
    const summary = groups.get(key) ?? {
      month,
      unit,
      net_pnl: 0,
      gross_profit: 0,
      gross_loss: 0,
      winning_trades: 0,
      losing_trades: 0,
      breakeven_trades: 0,
    };
    const pnl = row.trade.net_pnl;
    summary.net_pnl += pnl;
    if (pnl > 0) {
      summary.gross_profit += pnl;
      summary.winning_trades++;
    } else if (pnl < 0) {
      summary.gross_loss += pnl;
      summary.losing_trades++;
    } else summary.breakeven_trades++;
    groups.set(key, summary);
  }
  return [...groups.values()];
}

async function marketBrowser(t) {
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
    `<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/${path.basename(fixture)}/entry.tsx"></script></body></html>`,
  );
  await writeFile(
    path.join(fixture, 'entry.tsx'),
    `
import React from 'react';import {createRoot} from 'react-dom/client';import '/src/index.css';
import {initializeI18n} from '/src/i18n';await initializeI18n();
import {App} from '/src/app';
import {ThemeProvider} from '/src/components/theme/theme-provider';
createRoot(document.getElementById('root')!).render(<ThemeProvider><App/></ThemeProvider>);`,
  );
  // Exercise the host route tree, session guard and plugin loader. The rest of
  // the application sidebar has its own network requests and browser tests.
  await writeFile(
    path.join(fixture, 'layout.tsx'),
    `
import React from 'react';import { Outlet } from '@tanstack/react-router';
export function AppLayout() { return <main className="p-4 sm:ml-56"><Outlet /></main> }`,
  );
  vite = await createServer({
    configFile: false,
    envFile: false,
    root: webRoot,
    cacheDir: path.join(artifacts, 'vite'),
    resolve: {
      alias: [
        {
          find: '@/layouts/app-layout',
          replacement: path.join(fixture, 'layout.tsx'),
        },
        { find: '@', replacement: path.join(webRoot, 'src') },
      ],
      dedupe: ['react', 'react-dom', '@tanstack/react-router'],
    },
    optimizeDeps: { entries: [path.join(fixture, 'index.html')] },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'market-test-entry',
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (
              [
                '/p/vibe-quant',
                '/plugins/vibe-quant',
                '/vibe-quant',
                '/login',
              ].includes(
                new URL(req.url, 'http://localhost').pathname.replace(
                  /\/$/,
                  '',
                ),
              )
            )
              req.url = `/${path.basename(fixture)}/index.html`;
            next();
          });
        },
      },
    ],
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
  await page.route('**/api/auth/get-session**', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'market-reader',
          name: '行情用户',
          email: 'viewer@example.test',
          role: 'user',
        },
        session: {
          id: 'market-session',
          userId: 'market-reader',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      },
    }),
  );
  await page.route('**/api/plugins', (route) =>
    route.fulfill({ json: [{ id: 'vibe-quant', enabled: true }] }),
  );
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  return {
    page,
    errors,
    artifacts,
    marketUrl: `http://127.0.0.1:${vite.httpServer.address().port}/p/vibe-quant/`,
  };
}

test(
  'market positions: strategy filters, monthly totals, pagination, polling and responsive layout',
  { timeout: 120000 },
  async (t) => {
    const { page, errors, artifacts, marketUrl } = await marketBrowser(t);
    let failed = false,
      empty = false,
      count = 6,
      queries = [],
      barQueries = [],
      lastPrice = 7010.2,
      positionsGate = null;
    await page.route('**/api/plugins/vibe-quant/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/monitors/positions')) {
        queries.push(url.search);
        if (failed)
          return route.fulfill({
            status: 503,
            json: { code: 'STRATEGY_SERVICE_UNAVAILABLE' },
          });
        const selected = url.searchParams.getAll('strategy');
        const scopedMonitors = empty
          ? []
          : monitors.filter(
              (monitor) =>
                !selected.length || selected.includes(monitor.strategy_id),
            );
        const monitorIds = new Set(scopedMonitors.map((monitor) => monitor.id));
        const scopedHistory = closedPositions.filter((row) =>
          monitorIds.has(row.monitor_id),
        );
        const offset = url.searchParams.has('before') ? 50 : 0;
        if (positionsGate) await positionsGate;
        return route.fulfill({
          json: {
            strategies: empty
              ? []
              : monitors.map((monitor) => ({
                  id: monitor.strategy_id,
                  name: monitor.strategy_name,
                })),
            monitors: scopedMonitors,
            open: Array.from({ length: count }, (_, index) => ({
              monitor_id: `m${index % 2}`,
              trade: trade(index, true),
            })).filter((row) => monitorIds.has(row.monitor_id)),
            history: scopedHistory.slice(offset, offset + 50),
            next: scopedHistory.length > offset + 50 ? 'older-cursor' : null,
            monthly: monthlySummary(scopedHistory),
          },
        });
      }
      if (url.pathname.endsWith('/watchlist'))
        return route.fulfill({ json: watchlist });
      if (url.pathname.endsWith('/snapshot'))
        return route.fulfill({
          json: {
            status: { engine: 'tqsdk', state: 'syncing' },
            quotes: watchlist.map((item) => ({
              symbol: item.symbol,
              last: lastPrice,
              time: start + 900,
            })),
            orderBooks: [],
          },
        });
      if (url.pathname.endsWith('/bars')) {
        barQueries.push(url.search);
        const bars = Array.from({ length: 120 }, (_, index) => ({
          symbol: url.searchParams.get('symbol'),
          duration: Number(url.searchParams.get('duration')),
          time: start - 60 * 60 + index * 60,
          open: 7000 + index,
          high: 7002 + index,
          low: 6998 + index,
          close: 7001 + index,
          volume: 1000,
        }));
        return route.fulfill({
          json: url.searchParams.has('around')
            ? { bars, targetTime: Number(url.searchParams.get('around')) }
            : bars,
        });
      }
      return route.fulfill({ json: [] });
    });
    await page.goto(
      `${marketUrl}?symbol=SHFE.rb2701&monitor=m2&time=${start}&duration=300`,
      { timeout: 60000, waitUntil: 'domcontentloaded' },
    );
    await page.waitForURL(
      (url) =>
        url.pathname === '/vibe-quant' &&
        url.searchParams.get('monitor') === 'm2',
    );
    const sidebar = page.getByRole('complementary', { name: '策略持仓与行情' });
    const list = sidebar.getByRole('list', { name: '持仓记录列表' });
    const current = list.getByRole('listitem').filter({ hasText: '持仓中' });
    const history = list.getByRole('listitem').filter({ hasText: '已平仓' });
    const strategies = sidebar.getByRole('list', { name: '已加载策略列表' });
    const filter = sidebar.getByRole('button', { name: '按策略筛选' });
    const monthly = sidebar.getByRole('region', { name: '月度盈亏汇总' });
    const monthPicker = monthly.getByRole('combobox', { name: '统计月份' });
    const scopeResponse = (ids) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname.endsWith('/monitors/positions') &&
          !url.searchParams.has('before') &&
          url.searchParams.getAll('strategy').sort().join(',') ===
            [...ids].sort().join(',')
        );
      });
    const clearStrategyFilter = async () => {
      await filter.click();
      await Promise.all([
        scopeResponse([]),
        page.getByRole('menuitem', { name: '全部策略', exact: true }).click(),
      ]);
      await current.nth(5).waitFor();
    };
    await current.nth(5).waitFor();
    await current
      .first()
      .getByText('浮动盈亏 +2,000 元', { exact: true })
      .waitFor();
    await current
      .nth(1)
      .getByText('浮动盈亏 -10 点', { exact: true })
      .waitFor();
    assert.ok(
      barQueries.some(
        (query) =>
          query.includes('symbol=SHFE.rb2701') &&
          query.includes('monitor=m2') &&
          query.includes(`around=${start}`),
      ),
      'notification deep link opens a symbol outside the watchlist',
    );
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes('symbol=SSE.000852') &&
          response.url().includes(`around=${start - 60}`),
      ),
      current
        .nth(1)
        .getByRole('button', { name: /定位 SSE.000852 入场/ })
        .click(),
    ]);
    assert.ok(
      barQueries.some(
        (query) =>
          query.includes('symbol=SSE.000852') &&
          query.includes('monitor=m1') &&
          query.includes('duration=60') &&
          query.includes(`around=${start - 60}`),
      ),
    );
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes('symbol=CFFEX.IM2611') &&
          response.url().includes(`around=${start + 120}`),
      ),
      history
        .first()
        .getByRole('button', { name: /定位 CFFEX.IM2611 离场/ })
        .click(),
    ]);
    assert.equal(
      await current.getByText('CFFEX.IM2611', { exact: true }).count(),
      6,
    );
    assert.equal(
      await current.getByText('SSE.000852', { exact: true }).count(),
      3,
    );
    await history.nth(49).waitFor();
    const breakeven = history.filter({ hasText: '移动止损保本' });
    await breakeven.getByText('止损', { exact: true }).waitFor();
    await breakeven.getByText('净盈亏 0 元', { exact: true }).waitFor();
    await monthly.waitFor();
    assert.match(await monthPicker.innerText(), /2026.*10/);
    const octoberSummary = await monthly.innerText();
    const resultText = (label) =>
      monthly.getByText(label, { exact: true }).locator('../..').innerText();
    const currencySummary = await resultText('金额模拟');
    assert.match(currencySummary, /已平仓 26 笔/);
    assert.match(currencySummary, /净盈亏\s+\+720\s*元/);
    assert.match(currencySummary, /盈利合计\s+\+1,080 元/);
    assert.match(currencySummary, /亏损合计\s+-360 元/);
    assert.match(currencySummary, /盈利\s+9 笔/);
    assert.match(currencySummary, /亏损\s+8 笔/);
    assert.match(currencySummary, /持平\s+9 笔/);
    const pointsSummary = await resultText('点数模拟');
    assert.match(pointsSummary, /已平仓 25 笔/);
    assert.match(pointsSummary, /净盈亏\s+\+555\s*点/);
    assert.match(pointsSummary, /盈利合计\s+\+960 点/);
    assert.match(pointsSummary, /亏损合计\s+-405 点/);
    assert.match(pointsSummary, /盈利\s+8 笔/);
    assert.match(pointsSummary, /亏损\s+9 笔/);
    assert.match(pointsSummary, /持平\s+8 笔/);
    await monthPicker.click();
    await page.getByRole('option', { name: /2026.*09|2026.*9月/ }).click();
    const septemberSummary = await monthly.innerText();
    assert.match(await resultText('金额模拟'), /净盈亏\s+-45\s*元/);
    assert.match(await resultText('金额模拟'), /亏损\s+1 笔/);
    assert.match(await resultText('点数模拟'), /净盈亏\s+\+120\s*点/);
    assert.match(await resultText('点数模拟'), /盈利\s+1 笔/);
    await monthPicker.click();
    await page.getByRole('option', { name: /2026.*10/ }).click();
    assert.equal(await monthly.innerText(), octoberSummary);
    assert.equal(await list.getByRole('listitem').count(), 56);
    assert.match(await list.getByRole('listitem').nth(5).innerText(), /持仓中/);
    assert.match(await list.getByRole('listitem').nth(6).innerText(), /已平仓/);
    const viewport = sidebar
      .getByRole('tabpanel', { name: '持仓记录' })
      .locator('[data-slot="scroll-area-viewport"]');
    await viewport.evaluate((element) => {
      element.scrollTop = 320;
    });
    lastPrice = 6990.2;
    await current
      .first()
      .getByText('浮动盈亏 -2,000 元', { exact: true })
      .waitFor();
    assert.equal(
      await viewport.evaluate((element) => element.scrollTop),
      320,
      'live valuation preserves scroll',
    );
    await sidebar.getByRole('button', { name: '刷新策略持仓' }).click();
    await page.waitForResponse((response) =>
      response.url().endsWith('/monitors/positions'),
    );
    assert.equal(
      await viewport.evaluate((element) => element.scrollTop),
      320,
      'refresh preserves scroll',
    );
    await monthPicker.click();
    await page.getByRole('option', { name: /2026.*09|2026.*9月/ }).click();
    await sidebar.getByRole('button', { name: '更早持仓' }).click();
    await sidebar.getByText('历史第 2 页').waitFor();
    await page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll('[aria-label="持仓记录列表"] > li'),
        ].filter((row) => row.textContent.includes('已平仓')).length === 3,
    );
    assert.equal(
      await monthly.innerText(),
      septemberSummary,
      'history pagination preserves the selected month and its totals',
    );
    await monthPicker.click();
    await page.getByRole('option', { name: /2026.*10/ }).click();
    await current.nth(5).waitFor();
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
    assert.equal(
      await monthly.innerText(),
      octoberSummary,
      'monthly totals cover all 51 October trades and do not change with pagination',
    );

    let releasePositions;
    positionsGate = new Promise((resolve) => {
      releasePositions = resolve;
    });
    await filter.click();
    await page
      .getByRole('menuitemcheckbox', { name: '突破策略', exact: true })
      .click();
    assert.equal(
      await page.getByRole('menuitemcheckbox').count(),
      3,
      'all strategy options remain available while selecting',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[aria-label="持仓记录列表"] > li').length ===
        0,
    );
    assert.equal(
      await sidebar.getByText('趋势跟随策略', { exact: true }).count(),
      0,
      'changing the filter immediately hides records from the previous scope',
    );
    const singleResponse = scopeResponse(['s0']);
    positionsGate = null;
    releasePositions();
    await singleResponse;
    await history.nth(26).waitFor();
    assert.equal(await current.count(), 3);
    assert.equal(await history.count(), 27);
    assert.equal(
      await list.getByText('趋势跟随策略', { exact: true }).count(),
      0,
    );
    await sidebar.getByText('历史第 1 页').waitFor();
    assert.match(await monthly.innerText(), /720/);
    assert.doesNotMatch(await monthly.innerText(), /555/);
    await sidebar.getByRole('tab', { name: /已加载策略/ }).click();
    assert.equal(await strategies.getByRole('listitem').count(), 1);
    await strategies.getByText('突破策略', { exact: true }).waitFor();

    await filter.click();
    assert.equal(await page.getByRole('menuitemcheckbox').count(), 3);
    await Promise.all([
      scopeResponse(['s0', 's1']),
      page
        .getByRole('menuitemcheckbox', { name: '趋势跟随策略', exact: true })
        .click(),
    ]);
    assert.equal(
      await page
        .getByRole('menuitemcheckbox', { name: '突破策略', exact: true })
        .getAttribute('aria-checked'),
      'true',
    );
    assert.equal(
      await page
        .getByRole('menuitemcheckbox', { name: '趋势跟随策略', exact: true })
        .getAttribute('aria-checked'),
      'true',
    );
    await page.keyboard.press('Escape');
    await strategies.getByRole('listitem').nth(1).waitFor();
    assert.equal(await strategies.getByRole('listitem').count(), 2);
    await sidebar.getByRole('tab', { name: '持仓记录', exact: true }).click();
    await current.nth(5).waitFor();
    assert.equal(await monthly.innerText(), octoberSummary);

    await filter.click();
    await Promise.all([
      scopeResponse(['s1']),
      page
        .getByRole('menuitemcheckbox', { name: '突破策略', exact: true })
        .click(),
    ]);
    await page.keyboard.press('Escape');
    await history.nth(25).waitFor();
    assert.equal(await current.count(), 3);
    assert.equal(await list.getByText('突破策略', { exact: true }).count(), 0);
    assert.match(await monthly.innerText(), /555/);
    assert.doesNotMatch(await monthly.innerText(), /720/);
    await clearStrategyFilter();
    assert.equal(await monthly.innerText(), octoberSummary);

    await filter.click();
    await Promise.all([
      scopeResponse(['s2']),
      page
        .getByRole('menuitemcheckbox', { name: '均值回归策略', exact: true })
        .click(),
    ]);
    assert.equal(await page.getByRole('menuitemcheckbox').count(), 3);
    await page.keyboard.press('Escape');
    await sidebar.getByText('所选策略暂无持仓记录', { exact: true }).waitFor();
    assert.equal(await list.getByRole('listitem').count(), 0);
    await sidebar.getByRole('tab', { name: /已加载策略/ }).click();
    assert.equal(await strategies.getByRole('listitem').count(), 1);
    await strategies.getByText('均值回归策略', { exact: true }).waitFor();
    await sidebar.getByRole('tab', { name: '持仓记录', exact: true }).click();
    await clearStrategyFilter();
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
    failed = true;
    await filter.click();
    await Promise.all([
      scopeResponse(['s2']),
      page
        .getByRole('menuitemcheckbox', { name: '均值回归策略', exact: true })
        .click(),
    ]);
    await page.keyboard.press('Escape');
    await sidebar.getByRole('alert').filter({ visible: true }).waitFor();
    assert.equal(
      await monthly.count(),
      0,
      'a failed new scope does not present missing monthly data as an empty month',
    );
    assert.equal(
      await list.getByRole('listitem').count(),
      0,
      'a failed new scope never retains the previous strategy records',
    );
    failed = false;
    await Promise.all([
      scopeResponse(['s2']),
      sidebar.getByRole('button', { name: '重试持仓加载' }).click(),
    ]);
    await sidebar.getByText('所选策略暂无持仓记录', { exact: true }).waitFor();
    empty = true;
    await Promise.all([
      scopeResponse(['s2']),
      sidebar.getByRole('button', { name: '刷新策略持仓' }).click(),
    ]);
    assert.equal(
      await filter.isEnabled(),
      true,
      'a selected strategy can still be cleared after all strategy options disappear',
    );
    await filter.click();
    await page
      .getByRole('menuitemcheckbox')
      .first()
      .waitFor({ state: 'hidden' });
    await Promise.all([
      scopeResponse([]),
      page.getByRole('menuitem', { name: '全部策略', exact: true }).click(),
    ]);
    await sidebar
      .getByText('尚未添加策略', { exact: true })
      .filter({ visible: true })
      .waitFor();
    await sidebar.getByRole('tab', { name: /已加载策略/ }).click();
    await sidebar
      .getByText('尚未添加策略', { exact: true })
      .filter({ visible: true })
      .waitFor();
    empty = false;
    const defaults = { fast: 10, slow: 30, duration: 60 };
    const strategy = {
      id: 'custom',
      name: '参数测试',
      status: 'active',
      enabled: true,
      version_count: 1,
    };
    const version = {
      id: 'pinned-version',
      strategy_id: strategy.id,
      number: 2,
      parameters: defaults,
    };
    let loaded;
    await page.route('**/strategies', (route) =>
      route.fulfill({ json: [strategy] }),
    );
    await page.route('**/strategies/template', (route) =>
      route.fulfill({ json: { canRun: true } }),
    );
    await page.route('**/strategies/custom/primary-version', (route) =>
      route.fulfill({ json: version }),
    );
    await page.route('**/strategies/custom/monitors', (route) => {
      const input = route.request().postDataJSON();
      assert.equal(input.version_id, version.id);
      assert.deepEqual(input.parameter_overrides, { ...defaults, fast: 7 });
      loaded = {
        ...monitors[0],
        id: 'custom-run',
        attachment_id: 'custom-run',
        revision: 1,
        strategy_name: strategy.name,
        strategy_id: strategy.id,
        signals: [],
        overlay: { updated_at: null, levels: [] },
        config: {
          ...monitors[0].config,
          symbol: input.symbol,
          display_symbol: input.display_symbol,
          parameters: input.parameter_overrides,
        },
      };
      monitors.push(loaded);
      return route.fulfill({ json: loaded, status: 201 });
    });
    await page.route('**/strategies/monitors?*', (route) =>
      route.fulfill({ json: loaded ? [loaded] : [] }),
    );
    await page.route('**/strategies/monitors/custom-run/parameters', (route) =>
      route.fulfill({
        json: {
          defaults,
          current: loaded.config.parameters,
          revision: 1,
          canEdit: true,
        },
      }),
    );
    await page.route('**/strategies/monitors/custom-run', (route) => {
      const input = route.request().postDataJSON();
      assert.deepEqual(input, {
        revision: 1,
        parameter_overrides: { ...defaults, duration: 300 },
      });
      loaded = {
        ...loaded,
        id: 'recalculated',
        revision: 2,
        status: 'starting',
        config: {
          ...loaded.config,
          duration: 300,
          parameters: input.parameter_overrides,
        },
      };
      monitors[monitors.length - 1] = loaded;
      return route.fulfill({ json: loaded });
    });
    await page.getByRole('button', { name: '策略菜单' }).click();
    await page.getByRole('menuitem', { name: '添加策略提示' }).click();
    const picker = page.getByRole('dialog', { name: /添加策略提示/ });
    await picker.getByRole('spinbutton', { name: 'fast' }).fill('7');
    await picker.getByRole('button', { name: '添加', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    const card = strategies
      .getByRole('listitem')
      .filter({ hasText: strategy.name });
    const visibility = card.getByRole('switch');
    await visibility.click();
    await card.getByRole('button', { name: '编辑 参数测试 参数' }).click();
    const editor = page.getByRole('dialog', { name: '策略参数 · 参数测试' });
    assert.equal(
      await editor.getByRole('spinbutton', { name: 'fast' }).inputValue(),
      '7',
    );
    await editor.getByRole('button', { name: '恢复版本默认值' }).click();
    assert.equal(
      await editor.getByRole('spinbutton', { name: 'fast' }).inputValue(),
      '10',
    );
    await editor.getByRole('spinbutton', { name: 'duration' }).fill('300');
    await editor.getByRole('button', { name: '应用并重新计算' }).click();
    await editor.waitFor({ state: 'hidden' });
    await card.getByText('准备中', { exact: true }).waitFor();
    assert.equal(await visibility.getAttribute('aria-checked'), 'false');

    let removeAttempts = 0;
    await page.route('**/strategies/monitors/recalculated', (route) => {
      assert.equal(route.request().method(), 'PATCH');
      assert.deepEqual(route.request().postDataJSON(), {
        revision: 2,
        deleted: true,
        enabled: false,
      });
      if (++removeAttempts === 1)
        return route.fulfill({
          status: 409,
          json: { code: 'MONITOR_CONFLICT' },
        });
      const deleted = { ...loaded, deleted: true, enabled: false };
      monitors.splice(monitors.indexOf(loaded), 1);
      loaded = undefined;
      return route.fulfill({ json: deleted });
    });
    const remove = card.getByRole('button', { name: /移除 参数测试/ });
    await Promise.all([
      page.waitForResponse((response) => response.status() === 409),
      remove.click(),
    ]);
    assert.equal(await card.isVisible(), true);
    await remove.click();
    await card.waitFor({ state: 'detached' });
    assert.equal(removeAttempts, 2);
    assert.equal(await strategies.getByRole('listitem').count(), 3);
    const menu = page.getByRole('button', { name: '策略菜单' });
    assert.match(await menu.innerText(), /0/);
    assert.deepEqual(errors, []);
  },
);

test(
  'market search opens live and cached symbols independently of the watchlist',
  { timeout: 100000 },
  async (t) => {
    const { page, marketUrl, errors } = await marketBrowser(t);
    const historical = 'CFFEX.IM2610';
    const live = 'CFFEX.IM2612';
    const limited = 'CFFEX.IM2702';
    const catalog = [historical, live, limited].map((symbol) => ({
      symbol,
      name: symbol.split('.')[1],
      exchange: 'CFFEX',
      kind: 'future',
      product: 'IM',
      underlying: '',
      priceTick: 0.2,
      localHistory: true,
      expired: symbol === historical,
    }));
    const favorites = new Map([
      [historical, { ...catalog[0], enabled: false }],
    ]);
    const favoriteWrites = [];
    const requests = [];
    const released = new Set();
    const marketView = new Map();
    let quotePrice = 7321.2;
    await page.route('**/api/plugins/vibe-quant/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname.replace('/api/plugins/vibe-quant/', '');
      const symbol = url.searchParams.get('symbol');
      if (endpoint === 'watchlist' && request.method() === 'POST') {
        const added = request.postDataJSON().symbol;
        favoriteWrites.push(['add', added]);
        const entry = {
          ...catalog.find((item) => item.symbol === added),
          enabled: true,
        };
        favorites.set(added, entry);
        return route.fulfill({ json: entry, status: 201 });
      }
      if (endpoint === 'watchlist')
        return route.fulfill({ json: [...favorites.values()] });
      if (endpoint.startsWith('watchlist/') && request.method() === 'DELETE') {
        const deleted = endpoint.slice('watchlist/'.length);
        favoriteWrites.push(['remove', deleted]);
        favorites.delete(deleted);
        return route.fulfill({ json: { deleted: true } });
      }
      if (endpoint === 'instruments') {
        return route.fulfill({
          json: {
            items: catalog.filter((item) =>
              item.symbol.includes(url.searchParams.get('q') ?? ''),
            ),
            nextCursor: null,
          },
        });
      }
      if (endpoint.startsWith('market-view/')) {
        const id = endpoint.split('/')[1];
        if (request.method() === 'DELETE') {
          if (marketView.get(id) !== symbol)
            return route.fulfill({
              status: 400,
              json: { code: 'INVALID_SYMBOL' },
            });
          released.add(id);
          return route.fulfill({ json: { released: true } });
        }
        const viewed = request.postDataJSON().symbol;
        const instrument = catalog.find((entry) => entry.symbol === viewed);
        if (!instrument)
          return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
        marketView.set(id, viewed);
        return route.fulfill({
          json: {
            instrument,
            mode:
              viewed === historical
                ? 'history'
                : viewed === limited
                  ? 'limit'
                  : 'live',
            availableDurations: viewed === historical ? [86400] : [60, 86400],
          },
        });
      }
      if (endpoint === 'snapshot') {
        const subscribed = [
          ...new Set([...favorites.keys(), ...(symbol ? [symbol] : [])]),
        ];
        return route.fulfill({
          json: {
            status: { engine: 'tqsdk', state: 'syncing' },
            quotes: subscribed.map((symbol) => ({
              symbol,
              time: start,
              open: quotePrice,
              last: quotePrice,
            })),
            orderBooks: subscribed.map((symbol) => ({
              symbol,
              sourceTime: start,
              receivedAt: start,
              bidPrices: [quotePrice],
              askPrices: [quotePrice + 0.2],
              bidVolumes: [13],
              askVolumes: [16],
            })),
          },
        });
      }
      if (endpoint === 'bars') {
        const duration = Number(url.searchParams.get('duration'));
        requests.push({
          symbol,
          duration,
          around: url.searchParams.get('around'),
          monitor: url.searchParams.get('monitor'),
        });
        if (
          symbol === historical &&
          !url.searchParams.has('monitor') &&
          duration !== 86400
        )
          return route.fulfill({ json: [] });
        const bars = Array.from({ length: 4 }, (_, i) => ({
          symbol,
          duration,
          time: start + i * duration,
          open: 7250,
          high: 7255 + i,
          low: 7245,
          close: 7251 + i,
          volume: 100 + i,
        }));
        return route.fulfill({
          json: url.searchParams.has('around')
            ? { bars, targetTime: Number(url.searchParams.get('around')) }
            : bars,
        });
      }
      if (endpoint === 'product-sync')
        return route.fulfill({
          json: {
            options: [],
            matched: 0,
            ready: 0,
            selectedContracts: 0,
            writable: true,
          },
        });
      if (endpoint.endsWith('/monitors/positions'))
        return route.fulfill({
          json: {
            strategies: [],
            monitors: [],
            open: [],
            history: [],
            monthly: [],
            next: null,
          },
        });
      return route.fulfill({ json: [] });
    });

    async function result(symbol) {
      await page.getByRole('button', { name: '搜索代码或名称' }).click();
      const dialog = page.getByRole('dialog', { name: '搜索行情' });
      await dialog.getByRole('textbox').fill(symbol);
      const link = dialog.getByRole('link', { name: `查看 ${symbol} 行情` });
      const href = new URL(await link.getAttribute('href'), marketUrl);
      assert.equal(href.pathname, '/vibe-quant');
      assert.equal(href.searchParams.get('symbol'), symbol);
      return { dialog, link };
    }
    async function verifySelection(symbol, label) {
      await page.waitForURL(
        (url) =>
          url.pathname === '/vibe-quant' &&
          url.searchParams.get('symbol') === symbol,
      );
      await page.getByText(label, { exact: true }).waitFor();
      await page
        .getByRole('button', { name: 'K 线回放', exact: true, disabled: false })
        .waitFor();
      assert.ok(
        requests.some((query) => query.symbol === symbol && !query.monitor),
      );
    }

    await page.goto(marketUrl);
    await page.getByRole('button', { name: '移除 IM2610 自选' }).click();
    await page
      .getByRole('button', { name: '移除 IM2610 自选' })
      .waitFor({ state: 'detached' });

    const activeResult = await result(live);
    await activeResult.link.focus();
    await activeResult.link.press('Enter');
    await verifySelection(live, '实时行情');
    assert.equal(
      new URL(page.url()).pathname + new URL(page.url()).search,
      '/vibe-quant?symbol=CFFEX.IM2612',
    );
    const liveSession = [...marketView].find(
      ([, symbol]) => symbol === live,
    )?.[0];
    assert.ok(liveSession, 'opening a live symbol starts a chart session');
    await page.getByRole('tab', { name: '行情盘口' }).click();
    const book = page.getByRole('region', { name: '买卖盘口' });
    await book.getByText('7,321.20', { exact: true }).waitFor();
    quotePrice = 7329.4;
    await book.getByText('7,329.40', { exact: true }).waitFor();
    await page
      .getByLabel('行情概览', { exact: true })
      .getByText('7,329.40', { exact: true })
      .waitFor();

    await (await result(historical)).link.click();
    await verifySelection(historical, '历史行情');
    assert.ok(
      requests.some(
        (query) => query.symbol === historical && query.duration === 86400,
      ),
      'a retired contract with only cached daily candles opens its available period',
    );
    assert.ok(
      released.has(liveSession),
      'switching releases the chart-only live subscription',
    );
    assert.deepEqual(favoriteWrites, [['remove', historical]]);
    await page.reload();
    await verifySelection(historical, '历史行情');
    await page.goBack();
    await verifySelection(live, '实时行情');
    await page.goForward();
    await verifySelection(historical, '历史行情');
    await (await result(limited)).link.click();
    await verifySelection(limited, '实时名额已满');
    assert.deepEqual([...favorites], []);

    const addResult = await result(live);
    await addResult.dialog.getByRole('button', { name: '加入自选' }).click();
    await addResult.dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(favoriteWrites, [
      ['remove', historical],
      ['add', live],
    ]);
    assert.deepEqual([...favorites.keys()], [live]);
    const notification = new URL('/plugins/vibe-quant/', marketUrl);
    notification.search = new URLSearchParams({
      symbol: historical,
      monitor: 'past-trade',
      time: String(start),
      duration: '300',
    });
    const monitorRead = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith('/bars') &&
        url.searchParams.get('monitor') === 'past-trade' &&
        url.searchParams.get('around') === String(start)
      );
    });
    await page.goto(notification.href);
    await monitorRead;
    const canonical = new URL(page.url());
    assert.equal(canonical.pathname, '/vibe-quant');
    assert.deepEqual(
      Object.fromEntries(canonical.searchParams),
      Object.fromEntries(notification.searchParams),
    );

    await t.test(
      'signed-out market deep link survives refreshing login and submitting the sign-in form',
      async () => {
        favorites.clear();
        const beforeLogin = favoriteWrites.length;
        let signedIn = false;
        await page.route('**/api/auth/get-session**', (route) =>
          signedIn
            ? route.fallback()
            : route.fulfill({ body: 'null', contentType: 'application/json' }),
        );
        await page.route('**/api/auth/registration-status', (route) =>
          route.fulfill({
            json: {
              appName: 'Test',
              registrationEnabled: false,
              requestLoggingEnabled: false,
              messageCompressionTokens: 1024,
              e2bDesktopEnabled: false,
              e2bDesktopApiUrl: '',
              e2bDesktopTemplate: '',
              e2bDesktopTimeoutSeconds: 60,
              e2bDesktopHasApiKey: false,
              e2bDesktopManaged: false,
            },
          }),
        );
        await page.route('**/api/auth/sign-in/username', (route) => {
          const credentials = route.request().postDataJSON();
          signedIn =
            credentials.username === 'fixture_viewer' &&
            credentials.password === 'test-market-only';
          return signedIn
            ? route.fulfill({
                json: {
                  token: 'test-session',
                  user: { id: 'market-reader', username: 'fixture_viewer' },
                },
              })
            : route.fulfill({
                status: 401,
                json: { code: 'INVALID_CREDENTIALS' },
              });
        });

        const requested = new URL('/vibe-quant?symbol=CFFEX.IM2612', marketUrl);
        await page.goto(requested.href);
        await page.waitForURL((url) => url.pathname === '/login');
        assert.equal(
          new URL(page.url()).searchParams.get('returnTo'),
          requested.pathname + requested.search,
        );
        await page.getByRole('button', { name: '登录', exact: true }).waitFor();
        await page.reload();
        await page.getByLabel('用户名', { exact: true }).fill('fixture_viewer');
        await page.locator('input[name=password]').fill('test-market-only');
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await verifySelection(live, '实时行情');
        assert.equal(page.url(), requested.href);
        assert.equal(signedIn, true);
        assert.equal(favoriteWrites.length, beforeLogin);
        assert.deepEqual([...favorites], []);
      },
    );
    assert.deepEqual(errors, []);
  },
);
