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

test(
  'market positions: strategy filters, monthly totals, pagination, polling and responsive layout',
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
      `http://127.0.0.1:${vite.httpServer.address().port}/${path.basename(fixture)}/index.html?symbol=SHFE.rb2701&monitor=m2&time=${start}&duration=300`,
      { timeout: 60000, waitUntil: 'domcontentloaded' },
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
    assert.deepEqual(errors, []);
  },
);
