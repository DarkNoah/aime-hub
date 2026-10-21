/** Production group-chat UI with a deterministic RPC fixture, no user data or model calls. */
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
  'single-room UI: default scopes, hidden management, avatars, history, retry, drafts and mobile',
  { timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.group-chat-test-'));
    let vite, browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {GroupChatsPage} from '/src/pages/group-chats/page';
import {SessionContext} from '/src/features/auth/session-context';
import {initializeI18n} from '/src/i18n';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {Toaster} from '/src/components/ui/sonner';
import '/src/index.css';
const root=createRootRoute({component:()=> <SessionContext.Provider value={{data:{user:{id:'alice'},session:{id:'test'}},isPending:false}}><main style={{height:'100dvh'}}><Outlet/></main><Toaster/></SessionContext.Provider>});
const personal=createRoute({getParentRoute:()=>root,path:'/group-chats',component:GroupChatsPage});
const project=createRoute({getParentRoute:()=>root,path:'/projects/$projectId/group-chats',component:GroupChatsPage});
const tree=root.addChildren([personal,project,createRoute({getParentRoute:()=>root,path:'/projects/$projectId',component:()=>null})]);
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
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      plugins: [
        react(),
        tailwindcss(),
        {
          name: 'group-chat-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (!/^\/(projects|group-chats)(\/|$)/.test(req.url ?? ''))
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
      server: { host: '127.0.0.1', port: 5191 },
    });
    await vite.listen();
    const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const page = await browser.newPage({
      viewport: { width: 1100, height: 820 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const roomId = 'room000000000001';
    const projectId = 'project000000001';
    const rooms = [
      {
        id: roomId,
        title: '产品讨论',
        projectId,
        createdBy: 'alice',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    rooms.push({
      ...rooms[0],
      id: 'room000000000099',
      title: '隐藏的第二个聊天室',
    });
    const calls = [];
    const messages = Array.from({ length: 80 }, (_, i) => ({
      id: 'message' + String(i + 1).padStart(9, '0'),
      roomId,
      sequence: String(i + 1),
      senderId: i % 2 ? 'alice' : 'bob',
      text: `消息 ${i + 1}`,
      createdAt: new Date().toISOString(),
    }));
    const users = [
      { id: 'alice', name: '林然', username: 'alice', image: null },
      { id: 'bob', name: '陈禾', username: 'bob', image: null },
    ];
    let failSend = true,
      revoked = false,
      sendIds = [],
      earlierCalls = 0;
    await page.route('**/api/rpc/**', async (route) => {
      const endpoint = new URL(route.request().url()).pathname.split(
        '/api/rpc/',
      )[1];
      calls.push(endpoint);
      const input = route.request().postDataJSON()?.json ?? {};
      const failure = (code, status) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({
            json: { defined: false, code, status, message: code },
          }),
        });
      if (
        revoked &&
        endpoint.startsWith('groupChats/') &&
        !['groupChats/list', 'groupChats/create'].includes(endpoint)
      )
        return failure('NOT_FOUND', 404);
      let result;
      switch (endpoint) {
        case 'groupChats/openDefault': {
          const scope = input.body.projectId ?? null;
          let room = rooms.find((room) => room.projectId === scope);
          if (!room) {
            room = {
              ...rooms[0],
              id: 'personal00000001',
              projectId: null,
              title: 'Chat',
            };
            rooms.push(room);
          }
          result = {
            ...room,
            canManage: true,
            memberIds: scope ? ['alice', 'bob'] : ['alice'],
          };
          break;
        }
        case 'groupChats/get':
          result = {
            ...rooms.find((room) => room.id === input.params.roomId),
            canManage: true,
            memberIds: rooms.find((room) => room.id === input.params.roomId)
              ?.projectId
              ? ['alice', 'bob']
              : ['alice'],
          };
          break;
        case 'users/lookup':
          result = users.filter((user) => input.body.userIds.includes(user.id));
          break;
        case 'groupChats/messages': {
          const { before, after } = input.query;
          if (before) earlierCalls++;
          const found = messages.filter(
            (message) =>
              message.roomId === input.params.roomId &&
              (!before || BigInt(message.sequence) < BigInt(before)) &&
              (after === undefined || BigInt(message.sequence) > BigInt(after)),
          );
          result = {
            messages:
              after === undefined ? found.slice(-50) : found.slice(0, 50),
            hasMore: found.length > 50,
          };
          break;
        }
        case 'groupChats/send': {
          sendIds.push(input.body.id);
          result = messages.find((message) => message.id === input.body.id);
          if (!result) {
            result = {
              id: input.body.id,
              text: input.body.text,
              senderId: 'alice',
              roomId: input.params.roomId,
              sequence: String(messages.length + 1),
              createdAt: new Date().toISOString(),
            };
            messages.push(result);
          }
          if (failSend) {
            failSend = false;
            return failure('INTERNAL_ERROR', 500);
          }
          break;
        }
        default:
          throw new Error('Unexpected fixture RPC: ' + endpoint);
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ json: result }),
      });
    });
    const url = `${origin}/projects/${projectId}/group-chats`;
    await page.goto(url);
    await page.getByText('消息 80', { exact: true }).waitFor();
    assert.equal(await page.locator('aside').count(), 0);
    assert.equal(
      await page
        .getByRole('button', {
          name: /新建 Bots|Bots 操作|重命名 Bots|删除 Bots|返回 Bots 列表/,
        })
        .count(),
      0,
    );
    assert.equal(
      await page.getByText('隐藏的第二个聊天室', { exact: true }).count(),
      0,
    );

    await page.getByRole('button', { name: '2 位成员', exact: true }).click();
    await page.getByRole('dialog').getByText('陈禾', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    // Use the existing history control; its anchoring path is exercised on prepend.
    await page
      .getByRole('button', { name: '加载更早的消息', exact: true })
      .click();
    await page.getByText('消息 1', { exact: true }).waitFor();
    assert.ok(earlierCalls >= 1);
    assert.equal(await page.locator('[data-chat-turn]').count(), 80);
    const input = page.getByRole('textbox', { name: '输入消息…' });
    await input.fill('断线后重试');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page
      .getByText('操作失败，请重试。输入内容已保留。', { exact: true })
      .waitFor();
    assert.equal(await input.inputValue(), '断线后重试');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('textarea').value === '',
    );
    assert.equal(sendIds[0], sendIds[1]);
    assert.equal(
      messages.filter((message) => message.text === '断线后重试').length,
      1,
    );
    messages.push({
      id: 'external00000001',
      text: '另一位成员的新消息',
      roomId,
      sequence: String(messages.length + 1),
      senderId: 'bob',
      createdAt: new Date().toISOString(),
    });
    await page
      .getByText('另一位成员的新消息', { exact: true })
      .waitFor({ timeout: 8000 });
    await input.fill('切换和刷新后仍然保留的草稿');
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), '切换和刷新后仍然保留的草稿');
    await page.setViewportSize({ width: 360, height: 780 });
    await page.waitForFunction(
      () =>
        window.innerHeight === 780 &&
        document.documentElement.scrollHeight <= window.innerHeight,
    );
    assert.equal(
      await page.getByRole('heading', { name: 'Bots', exact: true }).count(),
      1,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.ok(await input.isVisible());
    await page.screenshot({
      path: '/tmp/group-chat-mobile.png',
      fullPage: false,
    });
    await page.goto(`${origin}/group-chats`);
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(
      await page
        .getByRole('button', {
          name: /新建 Bots|Bots 操作|重命名 Bots|删除 Bots/,
        })
        .count(),
      0,
    );
    assert.equal(await page.locator('aside').count(), 0);
    await input.fill('个人聊天室消息');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page
      .locator('[data-chat-turn]')
      .getByText('个人聊天室消息', { exact: true })
      .waitFor();
    await page.reload();
    await page
      .locator('[data-chat-turn]')
      .getByText('个人聊天室消息', { exact: true })
      .waitFor();
    await page.goto(url);
    await input.waitFor();
    assert.equal(await input.inputValue(), '切换和刷新后仍然保留的草稿');
    await page.setViewportSize({ width: 1100, height: 820 });
    await page.screenshot({
      path: '/tmp/group-chat-desktop.png',
      fullPage: true,
    });
    revoked = true;
    await page
      .getByRole('alert')
      .getByText('Bots 不存在，或你已没有访问权限。', { exact: true })
      .waitFor({ timeout: 8000 });
    assert.equal(await page.locator('textarea').count(), 0);
    assert.equal(await page.locator('[data-chat-turn]').count(), 0);
    assert.ok(
      !calls.some((call) =>
        [
          'groupChats/list',
          'groupChats/create',
          'groupChats/update',
          'groupChats/remove',
        ].includes(call),
      ),
    );
    assert.deepEqual(errors, []);
  },
);
