/** Production Issue components with deterministic RPC; no real tasks or model calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const webRequire = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const serverRequire = createRequire(
  new URL('../apps/server/package.json', import.meta.url),
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
  'issue board creates, edits, comments, queues, links to scoped chats, and fits mobile',
  { timeout: 180000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.issue-test-'));
    let vite, browser;
    t.after(async () => {
      await browser
        ?.contexts()[0]
        ?.pages()[0]
        ?.screenshot({ path: '/tmp/issues-browser-last.png', fullPage: true })
        .catch(() => {});
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useParams} from '@tanstack/react-router';
import {IssueBoard} from '/src/components/issues/board';
import {IssueToolResult} from '/src/components/chat/tool-renderers/issue';
import {validateGroupChatSearch} from '/src/pages/group-chats/search';
import {PersonalChatSettingsContext} from '/src/components/chat/use-personal-chat-settings';
import {initializeI18n} from '/src/i18n';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {Toaster} from '/src/components/ui/sonner';
import '/src/index.css';
const snapshot={settings:{model:null,reasoningEffort:'auto'},loading:false,saving:false,error:null};
const preferences={getSnapshot:()=>snapshot,subscribe:()=>()=>{},save:async()=>false,load:async()=>{}};
const root=createRootRoute({component:()=> <PersonalChatSettingsContext.Provider value={preferences}><main className="mx-auto max-w-7xl p-4"><Outlet/></main><Toaster/></PersonalChatSettingsContext.Provider>});
function Chat(){const {projectId,threadId}=useParams({strict:false});return <div className="h-[85dvh] w-full max-w-sm"><p data-testid="thread-id">{threadId}</p><IssueBoard compact projectId={projectId} threadId={threadId}/></div>;}
const tree=root.addChildren([
 createRoute({getParentRoute:()=>root,path:'/issues',component:()=> <IssueBoard/>}),
 createRoute({getParentRoute:()=>root,path:'/projects/$projectId',component:()=>{const {projectId}=useParams({strict:false});return <IssueBoard projectId={projectId}/>;}}),
 createRoute({getParentRoute:()=>root,path:'/threads/$threadId',component:Chat}),
 createRoute({getParentRoute:()=>root,path:'/projects/$projectId/threads/$threadId',component:Chat}),
 createRoute({getParentRoute:()=>root,path:'/group-chats',validateSearch:validateGroupChatSearch,component:()=> <p>群聊线程目标</p>}),
 createRoute({getParentRoute:()=>root,path:'/projects/$projectId/group-chats',validateSearch:validateGroupChatSearch,component:()=> <p>群聊线程目标</p>}),
 createRoute({getParentRoute:()=>root,path:'/tool',component:()=> <IssueToolResult tool={{type:'tool-issue',toolCallId:'fixture',state:'output-available',input:{command:'view 1'},output:{issue:{id:1,title:'工具任务',threadId:'thread0000000001',projectId:null,state:'todo'}}}}/>})
]);
const router=createRouter({routeTree:tree});
await initializeI18n();createRoot(document.getElementById('root')).render(<ThemeProvider><RouterProvider router={router}/></ThemeProvider>);`;
    await writeFile(path.join(fixture, 'entry.tsx'), entry);
    const entryUrl =
      '/' + path.relative(webRoot, path.join(fixture, 'entry.tsx'));
    vite = await createServer({
      root: webRoot,
      configFile: false,
      envFile: false,
      cacheDir: path.join(fixture, 'node_modules/.vite'),
      resolve: {
        alias: { '@': path.join(webRoot, 'src') },
        dedupe: ['react', 'react-dom'],
      },
      optimizeDeps: { exclude: ['@tldraw/assets'] },
      plugins: [
        react(),
        tailwindcss(),
        {
          name: 'issue-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (
                !/^\/(issues|projects|threads|tool|group-chats)(\/|$)/.test(
                  new URL(req.url ?? '/', 'http://fixture').pathname,
                )
              )
                return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await server.transformIndexHtml(
                  '/',
                  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="root"></div><script type="module" src="' +
                    entryUrl +
                    '"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(15000);
    let releaseRenderer;
    const rendererReady = new Promise((resolve) => {
      releaseRenderer = resolve;
    });
    t.after(() => releaseRenderer());
    await page.route(
      '**/src/components/ai-elements/message.tsx*',
      async (route) => {
        await rendererReady;
        await route.continue();
      },
    );
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const states = ['decision', 'todo', 'in_progress', 'done'];
    let nextId = 100;
    const now = '2026-10-31T04:00:00Z';
    const issues = states.flatMap((state, i) =>
      Array.from({ length: state === 'todo' ? 20 : 1 }, (_, j) => ({
        id: i * 25 + j + 1,
        title: j
          ? '待办任务 ' + j
          : ['确认验收范围', '准备项目方案', '实现搜索分页', '完成登录修复'][i],
        body: '任务描述和验收标准',
        state,
        threadId: 'thread' + String(i * 25 + j + 1).padStart(10, '0'),
        projectId: null,
        createdBy: 'alice',
        createdAt: now,
        updatedAt: now,
        closedAt: state === 'done' ? now : null,
      })),
    );
    issues.push({
      ...issues[0],
      id: 99,
      title: '项目中的任务',
      projectId: 'project000000001',
      threadId: 'projectthread001',
    });
    const comments = new Map();
    const calls = [];
    await page.route('**/api/rpc/**', async (route) => {
      const endpoint = new URL(route.request().url()).pathname.split(
        '/api/rpc/',
      )[1];
      const input = route.request().postDataJSON()?.json ?? {};
      calls.push({ endpoint, input });
      let result;
      const issue = issues.find((item) => item.id === input.id);
      if (endpoint === 'issues/list') {
        const scoped = issues.filter(
          (item) => item.projectId === (input.projectId ?? null),
        );
        const filtered = scoped
          .filter(
            (item) =>
              (input.state === 'all' || item.state === input.state) &&
              (!input.cursor || item.id < input.cursor),
          )
          .sort((a, b) => b.id - a.id);
        const items = filtered.slice(0, input.limit);
        result = {
          items,
          counts: Object.fromEntries(
            states.map((state) => [
              state,
              scoped.filter((item) => item.state === state).length,
            ]),
          ),
          nextCursor: filtered.length > input.limit ? items.at(-1).id : null,
        };
      } else if (endpoint === 'issues/forThread')
        result =
          issues.find(
            (item) =>
              item.threadId === input.threadId &&
              item.projectId === (input.projectId ?? null),
          ) ?? null;
      else if (endpoint === 'issues/create') {
        result = {
          ...input.data,
          id: nextId++,
          threadId:
            input.data.runInThread === false
              ? null
              : 'thread' + String(nextId).padStart(10, '0'),
          projectId: input.projectId ?? null,
          createdBy: 'alice',
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        };
        issues.push(result);
      } else if (endpoint === 'issues/view')
        result = {
          issue,
          comments: comments.get(input.id) ?? [],
          nextCursor: null,
        };
      else if (endpoint === 'issues/edit') {
        Object.assign(issue, input.data);
        result = issue;
      } else if (
        endpoint === 'issues/close' ||
        endpoint === 'issues/reopen' ||
        endpoint === 'issues/stop'
      ) {
        issue.state = endpoint.endsWith('close') ? 'done' : 'todo';
        result = issue;
      } else if (
        endpoint === 'issues/comment' ||
        endpoint === 'issues/message'
      ) {
        const comment = {
          id: 'comment' + calls.length,
          issueId: input.id,
          authorId: 'alice',
          authorName: 'Alice',
          body: input.data.body,
          kind: endpoint.endsWith('comment') ? 'comment' : 'message',
          delivery: input.data.delivery ?? null,
          createdAt: now,
        };
        comments.set(input.id, [...(comments.get(input.id) ?? []), comment]);
        if (comment.kind === 'message') issue.state = 'in_progress';
        result = comment.kind === 'comment' ? comment : issue;
      } else throw new Error('Unexpected RPC ' + endpoint);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ json: result }),
      });
    });
    const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
    await page.goto(origin + '/issues');
    await page.getByRole('link', { name: /确认验收范围/ }).waitFor();
    const openDetails = async (title, key) => {
      const before = page.url();
      const card = page.getByRole('button', {
        name: `查看 ${title} 的详情`,
        exact: true,
      });
      if (key) {
        await card.focus();
        await card.press(key);
      } else await card.click();
      await page
        .getByRole('dialog')
        .getByRole('heading', { name: title, exact: true })
        .waitFor();
      assert.equal(page.url(), before, 'card details must not navigate');
    };
    await openDetails('确认验收范围');
    const loadingBody = page
      .getByRole('dialog')
      .getByRole('article', { name: '任务描述' });
    assert.equal(
      await loadingBody.innerText(),
      '',
      'do not flash Markdown source while the renderer loads',
    );
    releaseRenderer();
    await loadingBody
      .getByText('任务描述和验收标准', { exact: true })
      .waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    for (const key of ['Enter', 'Space']) {
      await openDetails('确认验收范围', key);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    }
    assert.equal(
      await page.getByRole('region', { name: '待办', exact: true }).count(),
      1,
    );
    const stateLabels = ['待决策', '待办', '进行中', '已完成'];
    const columns = await Promise.all(
      stateLabels.map((name) =>
        page.getByRole('region', { name, exact: true }).boundingBox(),
      ),
    );
    for (let i = 1; i < columns.length; i++) {
      assert.equal(columns[i].y, columns[0].y);
      assert.ok(columns[i].x >= columns[i - 1].x + columns[i - 1].width);
    }
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page
      .getByRole('menuitemcheckbox', { name: '已完成', exact: true })
      .click();
    await page
      .getByRole('region', { name: '已完成', exact: true })
      .waitFor({ state: 'detached' });
    assert.equal(
      await page.getByRole('region', { name: '已完成', exact: true }).count(),
      0,
    );
    await page
      .getByRole('menuitem', { name: '显示全部状态', exact: true })
      .click();
    await page.getByRole('region', { name: '已完成', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('region', { name: '已完成', exact: true }).count(),
      1,
    );
    await page.getByRole('button', { name: '显示', exact: true }).click();
    await page
      .getByRole('menuitemcheckbox', { name: '描述摘要', exact: true })
      .click();
    await page
      .getByRole('menuitemcheckbox', { name: '更新日期', exact: true })
      .click();
    const firstCard = page
      .getByRole('button', { name: '查看 确认验收范围 的详情', exact: true })
      .locator('..');
    await firstCard.locator('p').waitFor({ state: 'detached' });
    await firstCard.locator('time').waitFor({ state: 'detached' });
    assert.equal(await firstCard.locator('p, time').count(), 0);
    await page
      .getByRole('menuitemcheckbox', { name: '描述摘要', exact: true })
      .click();
    await page
      .getByRole('menuitemcheckbox', { name: '更新日期', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: '在「进行中」中创建 Issue', exact: true })
      .click();
    const create = page.getByRole('dialog');
    assert.equal(await create.getByRole('combobox').textContent(), '进行中');
    assert.equal(
      await create.getByRole('switch', { name: '启用新线程' }).isChecked(),
      false,
    );
    await create.getByRole('switch', { name: '启用新线程' }).check();
    await create.getByLabel('标题', { exact: true }).fill('验证跨页任务');
    const markdownBody = [
      '## 验收',
      '',
      '**保留描述和评论**，支持 `issue` 命令。',
      '',
      '- [x] 创建成功',
      '- [ ] 完成验证',
      '',
      '> 保留引用说明',
      '',
      '| 项目 | 结果 |',
      '| --- | --- |',
      '| Markdown | 正常 |',
      '',
      '```ts',
      'const status = "done";',
      '```',
      '',
      '[文档链接](https://example.com/issues)',
    ].join('\n');
    await create.getByLabel('任务描述', { exact: true }).fill(markdownBody);
    await create
      .getByRole('button', { name: '创建 Issue', exact: true })
      .click();
    const detail = page.getByRole('dialog');
    await detail
      .getByRole('heading', { name: '验证跨页任务', exact: true })
      .waitFor();
    const body = detail.getByRole('article', { name: '任务描述' });
    await body.getByRole('heading', { name: '验收', level: 2 }).waitFor();
    assert.ok(
      await body
        .getByText('保留描述和评论', { exact: true })
        .evaluate(
          (element) => Number(getComputedStyle(element).fontWeight) >= 600,
        ),
    );
    assert.equal(await body.getByRole('checkbox').count(), 2);
    assert.equal(await body.getByRole('table').count(), 1);
    assert.equal(await body.locator('blockquote').innerText(), '保留引用说明');
    await body.locator('code').filter({ hasText: 'const status' }).waitFor();
    assert.equal(
      await body
        .getByRole('link', { name: '文档链接', exact: true })
        .getAttribute('href'),
      'https://example.com/issues',
    );
    await page.screenshot({ path: '/tmp/issue-markdown-desktop.png' });
    assert.equal(
      calls.find((call) => call.endpoint === 'issues/create').input.data.state,
      'in_progress',
    );
    await detail
      .getByLabel('添加评论或执行消息', { exact: true })
      .fill('### 讨论\n\n**补充背景**\n\n- 检查 Markdown 评论');
    await detail.getByRole('button', { name: '提交消息', exact: true }).click();
    await detail.getByText('补充背景', { exact: true }).waitFor();
    await detail.getByRole('heading', { name: '讨论', level: 3 }).waitFor();
    assert.equal(
      await detail
        .getByText('补充背景', { exact: true })
        .evaluate(
          (element) => Number(getComputedStyle(element).fontWeight) >= 600,
        ),
      true,
    );
    assert.equal(
      calls.filter((call) => call.endpoint === 'issues/message').length,
      0,
    );
    await detail.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('dialog').last();
    assert.equal(
      await editor.getByLabel('任务描述', { exact: true }).inputValue(),
      markdownBody,
    );
    await editor.getByLabel('标题', { exact: true }).fill('更新后的任务');
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    await detail
      .getByRole('heading', { name: '更新后的任务', exact: true })
      .waitFor();
    await detail
      .getByLabel('添加评论或执行消息', { exact: true })
      .fill('### 执行计划\n\n现在执行\n\n1. 验证渲染结果');
    await detail.getByRole('combobox', { name: '消息处理方式' }).click();
    await page.getByRole('option', { name: '立即处理', exact: true }).click();
    await detail.getByRole('button', { name: '提交消息', exact: true }).click();
    await detail.getByText('现在执行', { exact: true }).waitFor();
    await detail.getByRole('heading', { name: '执行计划', level: 3 }).waitFor();
    assert.equal(
      calls.find((call) => call.endpoint === 'issues/message').input.data
        .delivery,
      'immediate',
    );
    await detail.getByRole('button', { name: '标记完成', exact: true }).click();
    await detail
      .getByRole('button', { name: '重新打开', exact: true })
      .waitFor();
    await detail.getByRole('button', { name: '重新打开', exact: true }).click();
    await detail
      .getByRole('button', { name: '标记完成', exact: true })
      .waitFor();
    await detail.getByRole('link', { name: '打开线程', exact: true }).click();
    await page.getByTestId('thread-id').waitFor();
    assert.match(page.url(), /\/threads\/thread/);
    await page.getByText('当前线程的 Issue', { exact: true }).waitFor();
    await openDetails('更新后的任务');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: '/tmp/issues-compact.png', fullPage: true });
    await page.goto(origin + '/issues');
    await page.getByRole('link', { name: /更新后的任务/ }).waitFor();
    await page.screenshot({ path: '/tmp/issues-desktop.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() =>
      document.documentElement.classList.contains('dark'),
    );
    await page.screenshot({ path: '/tmp/issues-dark.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('link', { name: /确认验收范围/ }).click();
    assert.match(page.url(), /\/threads\/thread0000000001$/);
    await page.goto(origin + '/projects/project000000001');
    await openDetails('项目中的任务');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('link', { name: /项目中的任务/ }).click();
    assert.match(
      page.url(),
      /\/projects\/project000000001\/threads\/projectthread001$/,
    );
    await page.goto(origin + '/tool');
    await page.getByRole('link', { name: /工具任务/ }).click();
    assert.match(page.url(), /\/threads\/thread0000000001$/);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(origin + '/issues');
    await page.getByRole('link', { name: /确认验收范围/ }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: '/tmp/issues-mobile.png', fullPage: true });
    await openDetails('更新后的任务');
    const mobileBody = page
      .getByRole('dialog')
      .getByRole('article', { name: '任务描述' });
    await mobileBody.getByRole('heading', { name: '验收', level: 2 }).waitFor();
    assert.equal(
      await page
        .getByRole('dialog')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await page.screenshot({ path: '/tmp/issue-markdown-mobile.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await openDetails('完成登录修复');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('link', { name: /完成登录修复/ }).click();
    assert.match(page.url(), /\/threads\/thread0000000076$/);
    await page.goto(origin + '/issues');
    await page.getByRole('link', { name: /确认验收范围/ }).waitFor();
    await page.getByRole('button', { name: '创建 Issue', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('标题', { exact: true })
      .fill('窄屏表单');
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const submit = page
      .getByRole('dialog')
      .getByRole('button', { name: '创建 Issue', exact: true });
    assert.equal(await submit.isVisible(), true);
    await page.screenshot({
      path: '/tmp/issues-mobile-dialog.png',
      fullPage: true,
    });
    await page
      .getByRole('dialog')
      .getByRole('switch', { name: '启用新线程' })
      .uncheck();
    await submit.click();
    const recordSheet = page.getByRole('dialog');
    await recordSheet
      .getByRole('heading', { name: '窄屏表单', exact: true })
      .waitFor();
    const recordCreate = calls
      .filter((call) => call.endpoint === 'issues/create')
      .at(-1);
    assert.equal(recordCreate.input.data.runInThread, false);
    assert.equal(
      await recordSheet
        .getByRole('button', { name: '执行任务', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await recordSheet
        .getByRole('button', { name: '终止执行', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await recordSheet.getByRole('link', { name: /打开.*线程/ }).count(),
      0,
    );
    await recordSheet.getByText('仅记录', { exact: true }).waitFor();
    await recordSheet.getByRole('combobox').click();
    assert.equal(
      await page
        .getByRole('option', { name: '排队执行', exact: true })
        .getAttribute('aria-disabled'),
      'true',
    );
    await page.keyboard.press('Escape');
    await recordSheet
      .getByLabel('添加评论或执行消息', { exact: true })
      .fill('记录进展');
    await recordSheet
      .getByRole('button', { name: '提交消息', exact: true })
      .click();
    await recordSheet.getByText('记录进展', { exact: true }).waitFor();
    await recordSheet
      .getByRole('button', { name: '标记完成', exact: true })
      .click();
    await recordSheet
      .getByRole('button', { name: '重新打开', exact: true })
      .waitFor();
    await page.screenshot({
      path: '/tmp/issues-record-only.png',
      fullPage: true,
    });
    // Current cards and legacy stored tool results both resolve room sources.
    const source = {
      roomId: 'room000000000001',
      agentId: 'bot0000000000001',
      threadId: 'botthread0000001',
    };
    issues[0].source = source;
    for (const projectId of [null, 'project000000001']) {
      const item = projectId
        ? issues.find((item) => item.id === 99)
        : issues[0];
      item.source = source;
      await page.goto(
        origin + (projectId ? `/projects/${projectId}` : '/issues'),
      );
      await openDetails(item.title);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      const card = page.getByRole('link', { name: new RegExp(item.title) });
      const href = await card.getAttribute('href');
      assert.equal(
        new URL(href, origin).searchParams.get('agentId'),
        source.agentId,
      );
      const viewsBefore = calls.filter(
        (call) => call.endpoint === 'issues/view',
      ).length;
      await card.click();
      await page.getByText('群聊线程目标', { exact: true }).waitFor();
      assert.equal(
        calls.filter((call) => call.endpoint === 'issues/view').length,
        viewsBefore,
        'thread button must not also open details',
      );
      assert.equal(
        new URL(page.url()).pathname,
        projectId ? `/projects/${projectId}/group-chats` : '/group-chats',
      );
      await page.goBack();
      await page
        .getByRole('button', { name: `查看 ${item.title} 的详情` })
        .click();
      const sheet = page.getByRole('dialog');
      assert.match(
        await sheet
          .getByRole('link', { name: '打开群聊 Agent 线程' })
          .getAttribute('href'),
        /agentId=/,
      );
      await sheet.getByRole('link', { name: '打开任务线程' }).click();
      assert.match(page.url(), new RegExp(`/threads/${item.threadId}$`));
    }
    await page.goto(origin + '/tool');
    await page.waitForFunction(() =>
      document.querySelector('a')?.getAttribute('href')?.includes('agentId='),
    );
    await page.getByRole('link', { name: /工具任务/ }).click();
    assert.equal(
      new URL(page.url()).searchParams.get('agentId'),
      source.agentId,
    );
    assert.deepEqual(errors, []);
  },
);
