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
  'room UI: shared membership, protected leader, room discovery, history, drafts and mobile',
  { timeout: 180000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.group-chat-test-'));
    const streams = new Map();
    let toolRevision = 1;
    const fileReads = [];
    const threadReads = [];
    const turn = (index, threadId) => ({
      id: `${threadId}-turn-${index}`,
      user: {
        id: `${threadId}-user-${index}`,
        role: 'user',
        parts: [{ type: 'text', text: `线程事件 ${index}` }],
      },
      assistant: {
        id: `${threadId}-answer-${index}`,
        role: 'assistant',
        parts: [{ type: 'text', text: `执行记录 ${index} · ${threadId}` }],
      },
      hasDetails: index === 30,
      toolCount: index === 30 ? 1 : 0,
      revision: String(toolRevision),
      assetRevision: '',
      cursor: String(index),
    });
    const toolPart = () => ({
      type: 'tool-read_file',
      toolCallId: 'read-file-1',
      state: 'output-available',
      input: { path: 'report.md' },
      output: `调研工具结果 ${toolRevision}`,
    });
    const snapshot = (threadId) => ({
      thread: {
        id: threadId,
        title: 'Agent private thread',
        status: 'running',
        queueCount: 0,
        error: null,
      },
      turns: Array.from({ length: 20 }, (_, index) =>
        turn(index + 11, threadId),
      ),
      activeTurnId: `${threadId}-turn-30`,
      activeMessageId: `${threadId}-answer-30`,
      canContinue: true,
      history: { cursor: '11', hasMore: true },
      toolInteractions: [],
    });
    const emitThread = (stream, subscription, event = 'snapshot') => {
      const threadId = subscription.url.match(
        /\/threads\/([^/]+)\/messages/,
      )?.[1];
      if (!threadId) return;
      threadReads.push(threadId);
      const data = snapshot(threadId);
      if (event === 'update') {
        delete data.history;
        data.turns = [turn(30, threadId)];
      }
      stream.res.write(
        `event: event\ndata: ${JSON.stringify({ id: subscription.id, event, data: JSON.stringify(data) })}\n\n`,
      );
    };
    let vite, browser;
    t.after(async () => {
      const lastPage = browser?.contexts()[0]?.pages()[0];
      if (lastPage) {
        await lastPage
          .screenshot({ path: '/tmp/group-chat-agent-window-last.png' })
          .catch(() => {});
        await writeFile(
          '/tmp/group-chat-agent-window-last.html',
          await lastPage.content(),
        ).catch(() => {});
      }
      await browser?.close();
      for (const stream of streams.values()) stream.res.end();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
import {GroupChatsPage} from '/src/pages/group-chats/page';
import {validateGroupChatSearch} from '/src/pages/group-chats/search';
import {SessionContext} from '/src/features/auth/session-context';
import {initializeI18n} from '/src/i18n';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {PluginContext} from '/src/features/plugins/context';
import {Toaster} from '/src/components/ui/sonner';
import {AvailableModelsProvider} from '/src/features/models/available-models-provider';
import '/src/index.css';
const root=createRootRoute({component:()=> <SessionContext.Provider value={{data:{user:{id:'alice'},session:{id:'test'}},isPending:false}}><PluginContext.Provider value={{plugins:[],loading:false,error:false,refresh:async()=>{},setEnabled:async()=>{},saveConfig:async()=>({})}}><AvailableModelsProvider><main style={{height:'100dvh',display:'flex',flexDirection:'column'}}><Outlet/></main></AvailableModelsProvider></PluginContext.Provider><Toaster/></SessionContext.Provider>});
const personal=createRoute({getParentRoute:()=>root,path:'/group-chats',validateSearch:validateGroupChatSearch,component:GroupChatsPage});
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
      resolve: {
        alias: { '@': path.join(webRoot, 'src') },
        dedupe: ['react', 'react-dom'],
      },
      optimizeDeps: { exclude: ['@tldraw/assets'] },
      plugins: [
        react(),
        tailwindcss(),
        {
          name: 'group-chat-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              const pathname = new URL(req.url ?? '/', 'http://fixture')
                .pathname;
              if (pathname.startsWith('/api/realtime/')) {
                if (req.method === 'GET') {
                  res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                  });
                  const stream = { res, subscriptions: [] };
                  streams.set(pathname, stream);
                  res.on('close', () => {
                    if (streams.get(pathname) === stream)
                      streams.delete(pathname);
                  });
                  res.write('event: ready\ndata: {"generation":"fixture"}\n\n');
                } else {
                  let body = '';
                  for await (const chunk of req) body += chunk;
                  const stream = streams.get(pathname);
                  if (!stream) {
                    res.writeHead(409);
                    res.end();
                    return;
                  }
                  stream.subscriptions = JSON.parse(body).subscriptions;
                  for (const subscription of stream.subscriptions)
                    emitThread(stream, subscription);
                  res.writeHead(204);
                  res.end();
                }
                return;
              }
              if (
                !/^\/(projects|group-chats)(\/|$)/.test(
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
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(45000);
    t.after(async () => {
      if (!page.isClosed()) {
        await page
          .screenshot({ path: '/tmp/group-chat-agent-window-last.png' })
          .catch(() => {});
      }
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
    rooms.push({
      ...rooms[0],
      id: 'joined0000000001',
      projectId: null,
      createdBy: 'bob',
      ownerName: '陈禾',
      title: '共享调研',
    });
    const calls = [];
    const fileScopes = [];
    const uiResponses = [];
    const historyCursors = [];
    const agentUpdates = [];
    const memberAdds = [];
    const a2aCreates = [];
    const a2aUpdates = [];
    const a2aRemovals = [];
    const a2aMembersByRoom = new Map();
    const roomA2aMembers = (roomId) => {
      if (!a2aMembersByRoom.has(roomId)) a2aMembersByRoom.set(roomId, []);
      return a2aMembersByRoom.get(roomId);
    };
    const userLookups = [];
    const membersByRoom = new Map();
    let canManageProjectMembers = true;
    let canManagePersonalMembers = true;
    let revision = 80;
    const botFor = (roomId) => ({
      id: 'bot0000000000001',
      roomId,
      threadId: 'thread0000000001',
      name: 'Room assistant',
      role: 'bot',
      settings: { agentId: null, model: null, reasoningEffort: 'auto' },
      enabled: true,
      status: 'idle',
      error: null,
      lastReadSequence: '0',
      idleWakeHours: null,
    });
    const agentsByRoom = new Map();
    const roomAgents = (roomId) => {
      if (!agentsByRoom.has(roomId)) agentsByRoom.set(roomId, [botFor(roomId)]);
      return agentsByRoom.get(roomId);
    };
    const detail = (room) => ({
      ...room,
      canManage: room.projectId !== null || room.createdBy === 'alice',
      canManageMembers: room.projectId
        ? canManageProjectMembers
        : room.createdBy === 'alice' && canManagePersonalMembers,
      memberIds:
        membersByRoom.get(room.id) ??
        (room.projectId || room.createdBy !== 'alice'
          ? ['alice', 'bob']
          : ['alice']),
      agents: roomAgents(room.id),
      a2aMembers: roomA2aMembers(room.id),
      botAgentId: 'bot0000000000001',
    });
    const messages = Array.from({ length: 80 }, (_, i) => ({
      id: 'message' + String(i + 1).padStart(9, '0'),
      roomId,
      sequence: String(i + 1),
      revision: String(i + 1),
      senderKind: 'user',
      files: [],
      ui: null,
      uiResponse: null,
      replyToId: null,
      targetAgentId: null,
      reactions: [],
      senderId: i % 2 ? 'alice' : 'bob',
      text: `消息 ${i + 1}`,
      createdAt: new Date().toISOString(),
    }));
    const users = [
      { id: 'alice', name: '林然', username: 'alice', image: null },
      { id: 'bob', name: '陈禾', username: 'bob', image: null },
      { id: 'charlie', name: '周宁', username: 'charlie', image: null },
      { id: 'grace', name: '许晴', username: 'grace', image: null },
    ];
    let failSend = true,
      revoked = false,
      sendIds = [],
      earlierCalls = 0;
    const uploadSessions = new Map();
    const uploadedFiles = new Map();
    let failUpload = true;
    await page.route('**/api/threads/*/files/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.ok(
        url.pathname.startsWith('/api/threads/thread0000000001/files/'),
      );
      if (url.pathname.endsWith('/raw')) {
        const path = url.searchParams.get('path').replace(/^\.\//, '');
        const file = uploadedFiles.get(path);
        return route.fulfill({
          status: file ? 200 : 404,
          contentType: path.endsWith('.png') ? 'image/png' : 'text/plain',
          body: file ?? '',
        });
      }
      if (request.method() === 'DELETE') return route.fulfill({ status: 204 });
      if (url.pathname.endsWith('/uploads')) {
        if (failUpload) {
          failUpload = false;
          return route.fulfill({
            status: 400,
            json: { code: 'FILE_UPLOAD_FAILED' },
          });
        }
        const body = request.postDataJSON();
        const id = `upload-${uploadSessions.size + 1}`;
        uploadSessions.set(id, { ...body, data: Buffer.alloc(0) });
        return route.fulfill({
          json: { id, offset: 0, chunkSize: 1024 * 1024 },
        });
      }
      const id = url.pathname.split('/uploads/')[1].split('/')[0];
      const session = uploadSessions.get(id);
      assert.ok(session);
      if (request.method() === 'PUT') {
        assert.equal(
          Number(url.searchParams.get('offset')),
          session.data.length,
        );
        session.data = Buffer.concat([session.data, request.postDataBuffer()]);
        return route.fulfill({ json: { offset: session.data.length } });
      }
      assert.equal(session.data.length, session.size);
      uploadedFiles.set(session.path, session.data);
      return route.fulfill({ json: { path: session.path } });
    });
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
        case 'providers/available':
          result = {
            providers: [
              {
                id: 'fixture',
                name: '测试供应商',
                type: 'openai',
                enabled: true,
                models: [
                  {
                    providerId: 'fixture',
                    id: 'reasoning-model',
                    name: '测试推理模型',
                    displayName: '测试推理模型',
                    description: null,
                    enabled: true,
                    modelType: 'language',
                    modalitiesInput: ['text'],
                    modalitiesOutput: ['text'],
                    reasoning: true,
                    toolCall: true,
                    limitContext: 100000,
                    limitOutput: 10000,
                  },
                ],
              },
            ],
          };
          break;
        case 'agents/available':
          result = {
            defaultAgentId: 'default',
            agents: [
              {
                id: 'default',
                name: '调研助手',
                description: '',
                model: null,
                source: 'code',
              },
            ],
          };
          break;
        case 'groupChats/addAgent':
          result = {
            ...botFor(input.params.roomId),
            ...input.body,
            id: 'worker0000000001',
            threadId: 'workerthread0001',
            role: 'worker',
          };
          roomAgents(input.params.roomId).push(result);
          break;
        case 'groupChats/updateAgent':
          agentUpdates.push(structuredClone(input));
          result = roomAgents(input.params.roomId).find(
            (agent) => agent.id === input.params.agentId,
          );
          Object.assign(result, input.body);
          break;
        case 'groupChats/removeAgent':
          agentsByRoom.set(
            input.params.roomId,
            roomAgents(input.params.roomId).filter(
              (agent) => agent.id !== input.params.agentId,
            ),
          );
          return route.fulfill({ status: 204 });
        case 'groupChats/openDefault': {
          const scope = input.body.projectId ?? null;
          let room = rooms.find(
            (room) =>
              room.projectId === scope &&
              (scope !== null || room.createdBy === 'alice'),
          );
          if (!room) {
            room = {
              ...rooms[0],
              id: 'personal00000001',
              projectId: null,
              title: 'Chat',
            };
            rooms.push(room);
          }
          result = detail(room);
          break;
        }
        case 'groupChats/list': {
          const found = rooms.filter(
            (room) => room.projectId === (input.query.projectId ?? null),
          );
          result = { rooms: found, hasMore: false };
          break;
        }
        case 'groupChats/searchUsers': {
          const room = rooms.find((room) => room.id === input.params.roomId);
          const members = detail(room).memberIds;
          const query = input.query.query.toLowerCase();
          result = users.filter(
            (user) =>
              !members.includes(user.id) &&
              `${user.name} ${user.username}`.toLowerCase().includes(query),
          );
          break;
        }
        case 'groupChats/addMember': {
          const room = rooms.find((room) => room.id === input.params.roomId);
          assert.equal(detail(room).canManageMembers, true);
          const current = detail(room).memberIds;
          membersByRoom.set(room.id, [
            ...new Set([...current, input.body.userId]),
          ]);
          memberAdds.push(structuredClone(input));
          result = users.find((user) => user.id === input.body.userId);
          break;
        }
        case 'groupChats/createA2aMember': {
          a2aCreates.push(structuredClone(input));
          const room = rooms.find((room) => room.id === input.params.roomId);
          assert.equal(detail(room).canManageMembers, true);
          const member = {
            id: `a2amember${String(roomA2aMembers(room.id).length + 1).padStart(7, '0')}`,
            roomId: room.id,
            name: input.body.name,
            publicOrigin: input.body.publicOrigin ?? null,
            description: input.body.description ?? '',
            enabled: true,
            keyPrefix: 'room_test',
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            revokedAt: null,
          };
          roomA2aMembers(room.id).push(member);
          result = { member, apiKey: `fixture_secret_${member.id}` };
          break;
        }
        case 'groupChats/updateA2aMember': {
          a2aUpdates.push(structuredClone(input));
          result = roomA2aMembers(input.params.roomId).find(
            (member) => member.id === input.params.memberId,
          );
          Object.assign(result, input.body);
          break;
        }
        case 'groupChats/revokeA2aMember': {
          result = roomA2aMembers(input.params.roomId).find(
            (member) => member.id === input.params.memberId,
          );
          Object.assign(result, {
            enabled: false,
            revokedAt: new Date().toISOString(),
          });
          break;
        }
        case 'groupChats/removeA2aMember': {
          const room = rooms.find((room) => room.id === input.params.roomId);
          assert.equal(detail(room).canManageMembers, true);
          a2aRemovals.push(structuredClone(input));
          a2aMembersByRoom.set(
            room.id,
            roomA2aMembers(room.id).filter(
              (member) => member.id !== input.params.memberId,
            ),
          );
          return route.fulfill({ status: 204 });
        }
        case 'groupChats/get':
          result = detail(
            rooms.find((room) => room.id === input.params.roomId),
          );
          break;
        case 'files/list':
          fileScopes.push(input.query.scope);
          result = { entries: [], truncated: false };
          break;
        case 'files/mutate':
          result = {};
          break;
        case 'threads/history':
          assert.equal(input.query.view, 'summary');
          result = {
            turns: Array.from({ length: 10 }, (_, i) =>
              turn(i + 1, input.params.threadId),
            ),
            cursor: null,
            hasMore: false,
          };
          break;
        case 'threads/turn': {
          const current = turn(30, input.params.threadId);
          result = {
            id: input.params.turnId,
            revision: String(toolRevision),
            messages: [
              current.user,
              {
                ...current.assistant,
                parts: [toolPart(), ...current.assistant.parts],
              },
            ],
          };
          break;
        }
        case 'files/resolve':
          fileReads.push({ endpoint, ...input });
          result = { kind: 'file', path: input.query.path, scope: 'shared' };
          break;
        case 'files/preview':
          fileReads.push({ endpoint, ...input });
          result = {
            kind: 'text',
            path: input.query.path,
            mime: 'text/markdown',
            text: `# ${input.params.threadId} 的文件\n\n仅在当前 Agent 窗口内预览。`,
            size: 40,
            modifiedAt: new Date().toISOString(),
          };
          break;
        case 'groupChats/react': {
          result = messages.find(
            (message) => message.id === input.params.messageId,
          );
          const { emoji, active } = input.body;
          const current =
            result.reactions.find((reaction) => reaction.emoji === emoji)
              ?.memberIds ?? [];
          const memberIds = active
            ? [...new Set([...current, 'alice'])]
            : current.filter((id) => id !== 'alice');
          result.reactions = result.reactions.filter(
            (reaction) => reaction.emoji !== emoji,
          );
          if (memberIds.length) result.reactions.push({ emoji, memberIds });
          result.revision = String(++revision);
          break;
        }
        case 'groupChats/respondUi': {
          uiResponses.push(input);
          result = messages.find((message) => message.id === input.body.id);
          if (!result) {
            result = {
              ...messages[0],
              id: input.body.id,
              roomId: input.params.roomId,
              sequence: String(messages.length + 1),
              revision: String(++revision),
              senderId: 'alice',
              senderKind: 'user',
              text: '交互结果 ' + JSON.stringify(input.body.data),
              replyToId: input.params.messageId,
              uiResponse: {
                sourceMessageId: input.params.messageId,
                data: input.body.data,
              },
            };
            messages.push(result);
          }
          break;
        }
        case 'users/lookup':
          userLookups.push(...input.body.userIds);
          result = users.filter((user) => input.body.userIds.includes(user.id));
          break;
        case 'groupChats/messages': {
          const { before, after, afterRevision } = input.query;
          if (before) {
            earlierCalls++;
            historyCursors.push(before);
          }
          const found = messages.filter(
            (message) =>
              message.roomId === input.params.roomId &&
              (!before || BigInt(message.sequence) < BigInt(before)) &&
              (after === undefined ||
                BigInt(message.sequence) > BigInt(after)) &&
              (afterRevision === undefined ||
                BigInt(message.revision ?? message.sequence) >
                  BigInt(afterRevision)),
          );
          const updates = afterRevision !== undefined;
          if (updates)
            found.sort((a, b) =>
              Number(
                BigInt(a.revision ?? a.sequence) -
                  BigInt(b.revision ?? b.sequence),
              ),
            );
          const batch =
            after === undefined && !updates
              ? found.slice(-50)
              : found.slice(0, 50);
          result = {
            messages: batch,
            hasMore: found.length > 50,
            revision:
              updates && found.length > 50
                ? batch.at(-1).revision
                : String(revision),
          };
          break;
        }
        case 'groupChats/send': {
          sendIds.push(input.body.id);
          result = messages.find((message) => message.id === input.body.id);
          if (!result) {
            result = {
              ...messages[0],
              id: input.body.id,
              replyToId: input.body.replyToId ?? null,
              revision: String(++revision),
              text: input.body.text,
              files: input.body.files ?? [],
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
    assert.equal(await page.locator('aside').count(), 1);
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

    const input = page.getByRole('textbox', { name: '输入消息…' });
    await input.fill('切换成员面板时保留草稿');
    await page.getByRole('button', { name: '3 位成员', exact: true }).click();
    const roster = page.getByRole('complementary', {
      name: '成员',
      exact: true,
    });
    await roster.getByText('陈禾', { exact: true }).waitFor();
    await roster.getByText('林然', { exact: true }).waitFor();
    await roster.getByText('Room assistant', { exact: true }).waitFor();
    await roster.getByText('领导', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByRole('complementary').count(), 1);
    assert.equal(await page.locator('[data-chat-turn]').count(), 50);
    assert.equal(await input.inputValue(), '切换成员面板时保留草稿');
    assert.equal(
      await roster
        .getByRole('switch', { name: '启用 Room assistant', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await roster
        .getByRole('button', { name: '移除 Room assistant', exact: true })
        .count(),
      0,
    );
    await roster
      .getByRole('button', { name: '配置 Room assistant', exact: true })
      .click();
    const leaderEditor = page.getByRole('dialog', {
      name: '配置 Agent',
      exact: true,
    });
    assert.equal(
      await leaderEditor.getByRole('textbox', { name: '显示名称' }).count(),
      0,
    );
    assert.equal(await leaderEditor.getByRole('switch').count(), 1);
    await leaderEditor.getByRole('switch', { name: '空闲时主动启动' }).check();
    await leaderEditor
      .getByRole('spinbutton', { name: '空闲启动时间（小时）' })
      .fill('0');
    assert.equal(
      await leaderEditor.getByRole('button', { name: '保存配置' }).isEnabled(),
      false,
    );
    await leaderEditor
      .getByRole('spinbutton', { name: '空闲启动时间（小时）' })
      .fill('0.5');
    assert.equal(await leaderEditor.getByRole('combobox').count(), 1);
    await leaderEditor.getByRole('button', { name: /^聊天模型:/ }).click();
    await page.getByRole('option', { name: /测试推理模型/ }).click();
    await leaderEditor.getByRole('combobox', { name: '思考等级' }).click();
    await page.getByRole('option', { name: '高', exact: true }).click();
    await leaderEditor
      .getByRole('button', { name: '保存配置', exact: true })
      .click();
    await leaderEditor.waitFor({ state: 'hidden' });
    const leaderUpdate = agentUpdates.find(
      (update) => update.params.agentId === 'bot0000000000001',
    );
    assert.deepEqual(leaderUpdate.body, {
      idleWakeHours: 0.5,
      settings: {
        agentId: null,
        model: 'fixture/reasoning-model',
        reasoningEffort: 'high',
      },
    });
    await roster
      .getByRole('button', { name: '配置 Room assistant', exact: true })
      .click();
    assert.equal(
      await leaderEditor
        .getByRole('switch', { name: '空闲时主动启动' })
        .isChecked(),
      true,
    );
    assert.equal(
      await leaderEditor
        .getByRole('spinbutton', { name: '空闲启动时间（小时）' })
        .inputValue(),
      '0.5',
    );
    await page.screenshot({ path: '/tmp/group-chat-idle-settings.png' });
    await leaderEditor
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await roster
      .getByRole('button', { name: '添加 Agent', exact: true })
      .click();
    const editor = page.getByRole('dialog', {
      name: '添加 Agent',
      exact: true,
    });
    assert.equal(await editor.getByRole('textbox').count(), 0);
    assert.equal(await editor.getByRole('combobox').count(), 0);
    await editor
      .getByRole('checkbox', { name: '调研助手', exact: true })
      .check();
    await page.screenshot({ path: '/tmp/group-chat-agent-picker.png' });
    await editor
      .getByRole('button', { name: '添加所选 Agent', exact: true })
      .click();
    await editor.waitFor({ state: 'hidden' });
    await roster.getByText('调研助手', { exact: true }).waitFor();
    await input.fill('@调');
    await page.getByRole('option', { name: /@调研助手/ }).waitFor();
    await input.press('Enter');
    assert.equal(await input.inputValue(), '@调研助手 ');
    assert.equal(sendIds.length, 0);
    await input.press('End');
    await input.pressSequentially('请检查');
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('listbox').count(), 0);
    await input.fill('/');
    assert.equal(await page.getByRole('listbox').count(), 0);
    assert.equal(
      await page.locator('[data-chat-composer]').getByRole('combobox').count(),
      0,
    );
    await input.fill('草稿');
    await input.press('End');
    await roster
      .getByRole('button', { name: '提及 调研助手', exact: true })
      .click();
    await page.waitForFunction(
      () => document.activeElement === document.querySelector('textarea'),
    );
    assert.equal(await input.inputValue(), '草稿 @调研助手 ');
    await page.getByRole('button', { name: '4 位成员', exact: true }).click();
    await input.fill('切换成员面板时保留草稿');
    await roster
      .getByRole('switch', { name: '启用 调研助手', exact: true })
      .click();
    await roster.getByText('已停用', { exact: true }).waitFor();
    await page.screenshot({
      path: '/tmp/group-chat-members-desktop.png',
      fullPage: false,
    });
    await page.getByRole('button', { name: '文件管理', exact: true }).click();
    await page.getByRole('button', { name: '4 位成员', exact: true }).click();
    await roster.getByText('调研助手', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '切换成员面板时保留草稿');
    assert.equal(await page.locator('[data-chat-turn]').count(), 50);
    // Agent history opens inside the member panel, preserving its roster and scroll.
    const rosterScroll = roster.locator('[data-radix-scroll-area-viewport]');
    const savedRosterScroll = await rosterScroll.evaluate(
      (element) => element.scrollTop,
    );
    await roster
      .getByRole('button', { name: '查看 调研助手 的线程消息', exact: true })
      .click();
    const agentDrawer = page.locator('[data-agent-thread-drawer]');
    const viewer = page.getByRole('dialog', {
      name: '调研助手 的线程',
      exact: true,
    });
    await viewer
      .getByText('执行记录 30 · workerthread0001', { exact: true })
      .waitFor();
    assert.equal(page.url(), url);
    assert.equal(await input.inputValue(), '切换成员面板时保留草稿');
    assert.equal(
      await viewer.locator('textarea, aside, [contenteditable=true]').count(),
      0,
    );
    assert.equal(
      await viewer
        .getByRole('button', { name: /停止|继续生成|重试|发送消息|聊天模型/ })
        .count(),
      0,
    );
    assert.equal(
      await viewer
        .getByRole('link', { name: '打开完整线程' })
        .getAttribute('href'),
      `/projects/${projectId}/threads/workerthread0001`,
    );
    await viewer
      .getByRole('button', { name: '加载更早的消息', exact: true })
      .click();
    await viewer.getByText('线程事件 1', { exact: true }).waitFor();
    assert.equal(await viewer.locator('[data-chat-turn]').count(), 30);
    const lastTurn = viewer.locator(
      '[data-chat-turn="workerthread0001-turn-30"]',
    );
    await lastTurn
      .getByRole('button', { name: '查看详情', exact: true })
      .click();
    await lastTurn
      .getByRole('button', { name: '工具执行 · 1 次调用', exact: true })
      .click();
    await lastTurn.getByRole('button', { name: /^read_file/ }).click();
    await viewer
      .getByRole('button', { name: '返回消息', exact: true })
      .waitFor();
    const messageScroll = viewer.locator('[data-chat-messages]');
    const savedScroll = await messageScroll.evaluate(
      (element) =>
        element.closest('[data-radix-scroll-area-viewport]').scrollTop,
    );
    await viewer.getByText('调研工具结果 1', { exact: true }).waitFor();
    toolRevision++;
    for (const stream of streams.values())
      for (const subscription of stream.subscriptions)
        emitThread(stream, subscription, 'update');
    await viewer.getByText('调研工具结果 2', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/group-chat-agent-tool-preview.png' });
    await viewer
      .getByRole('button', { name: '在文件预览中打开 report.md', exact: true })
      .click();
    await viewer
      .getByRole('heading', { name: 'workerthread0001 的文件', exact: true })
      .waitFor();
    assert.deepEqual(
      fileReads.map((request) => request.params.threadId),
      ['workerthread0001', 'workerthread0001'],
    );
    assert.equal(fileReads[1].query.scope, 'shared');
    await viewer
      .getByRole('button', { name: '返回工具预览', exact: true })
      .click();
    await viewer.getByText('调研工具结果 2', { exact: true }).waitFor();
    await viewer.getByRole('button', { name: '返回消息', exact: true }).click();
    const restoredScroll = await messageScroll.evaluate(
      (element) =>
        element.closest('[data-radix-scroll-area-viewport]').scrollTop,
    );
    assert.ok(
      Math.abs(savedScroll - restoredScroll) < 2,
      'Tool preview must preserve message scroll',
    );
    assert.equal(await viewer.locator('[data-chat-turn]').count(), 30);
    await lastTurn
      .getByRole('button', { name: '收起详情', exact: true })
      .waitFor();
    assert.equal(await roster.locator('[data-agent-thread-drawer]').count(), 1);
    assert.equal(
      await agentDrawer.locator('[data-resize-direction]').count(),
      0,
    );
    const panelRect = await roster.boundingBox();
    const threadRect = await agentDrawer.boundingBox();
    assert.ok(
      threadRect.x >= panelRect.x && threadRect.width <= panelRect.width,
    );
    await page.screenshot({ path: '/tmp/group-chat-agent-thread-desktop.png' });
    await viewer.getByRole('button', { name: '返回成员', exact: true }).click();
    await viewer.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('aria-label') ===
        '查看 调研助手 的线程消息',
    );
    assert.equal(
      await rosterScroll.evaluate((element) => element.scrollTop),
      savedRosterScroll,
    );
    // Returning to the roster and opening the leader resets the preview scope.
    await roster
      .getByRole('button', {
        name: '查看 Room assistant 的线程消息',
        exact: true,
      })
      .click();
    const leaderDrawer = page.getByRole('dialog', {
      name: 'Room assistant 的线程',
      exact: true,
    });
    await leaderDrawer
      .getByText('执行记录 30 · thread0000000001', { exact: true })
      .waitFor();
    assert.equal(await page.locator('[data-agent-thread-drawer]').count(), 1);
    assert.equal(
      await leaderDrawer.getByText('调研工具结果 2', { exact: true }).count(),
      0,
    );
    await leaderDrawer
      .getByRole('button', { name: '返回成员', exact: true })
      .click();
    await agentDrawer.waitFor({ state: 'hidden' });
    assert.ok(
      threadReads.includes('workerthread0001') &&
        threadReads.includes('thread0000000001'),
    );
    assert.ok(
      !calls.some((call) =>
        /^threads\/(abort|run|retry|continue|stopSpeech|respondToTool|update)$/.test(
          call,
        ),
      ),
    );
    await roster
      .getByRole('button', { name: '移除 调研助手', exact: true })
      .click();
    await roster
      .getByText('调研助手', { exact: true })
      .waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '3 位成员', exact: true }).waitFor();
    await roster.getByRole('button', { name: '添加成员', exact: true }).click();
    const memberEditor = page.getByRole('dialog', {
      name: '添加成员',
      exact: true,
    });
    await memberEditor.getByRole('textbox').fill('周宁');
    await memberEditor.getByRole('button', { name: /周宁/ }).click();
    await memberEditor
      .getByRole('button', { name: '添加成员', exact: true })
      .click();
    await memberEditor.waitFor({ state: 'hidden' });
    await roster.getByText('周宁', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '切换成员面板时保留草稿');
    assert.equal(await page.locator('[data-chat-turn]').count(), 50);
    assert.deepEqual(memberAdds[0], {
      params: { roomId },
      body: { userId: 'charlie' },
    });
    canManageProjectMembers = false;
    await roster
      .getByRole('button', { name: '添加成员', exact: true })
      .waitFor({ state: 'hidden' });
    await roster
      .getByRole('button', { name: '添加 Agent', exact: true })
      .waitFor();
    canManageProjectMembers = true;
    await roster.getByRole('button', { name: '关闭', exact: true }).click();
    await input.fill('');
    // A reaction on unloaded message 1 must not move the history boundary
    // from 31 to 1 and skip messages 2..30 on the next history request.
    assert.equal(await page.locator('[data-chat-turn]').count(), 50);
    messages[0].reactions = [{ emoji: '👀', memberIds: ['bob'] }];
    messages[0].revision = String(++revision);
    messages[79].reactions = [{ emoji: '🎉', memberIds: ['bob'] }];
    messages[79].revision = String(++revision);
    await page
      .locator('[data-chat-turn="message000000080"]')
      .getByRole('button', { name: '🎉 · 1 位成员', exact: true })
      .waitFor();
    assert.equal(
      await page.locator('[data-chat-turn="message000000001"]').count(),
      0,
    );
    assert.equal(await page.locator('[data-chat-turn]').count(), 50);
    // Use the existing history control; its anchoring path is exercised on prepend.
    await page.mouse.move(1, 1);
    await page
      .locator('[data-sonner-toast]')
      .last()
      .waitFor({ state: 'hidden' });
    await page
      .getByRole('button', { name: '加载更早的消息', exact: true })
      .click();
    await page.getByText('消息 1', { exact: true }).waitFor();
    assert.ok(earlierCalls >= 1);
    assert.equal(historyCursors[0], '31');
    await page.getByText('消息 2', { exact: true }).waitFor();
    await page.getByText('消息 30', { exact: true }).waitFor();
    await page
      .locator('[data-chat-turn="message000000001"]')
      .getByRole('button', { name: '👀 · 1 位成员', exact: true })
      .waitFor();
    assert.equal(await page.locator('[data-chat-turn]').count(), 80);
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
      ...messages[0],
      revision: String(++revision),
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
    // Reactions update the existing message without changing history order.
    const first = page.locator('[data-chat-turn="message000000001"]');
    await first.getByRole('button', { name: '添加回应', exact: true }).click();
    await page.getByRole('button', { name: '👍', exact: true }).click();
    await first
      .getByRole('button', { name: '👍 · 1 位成员', exact: true })
      .waitFor();
    await first.getByRole('button', { name: '添加回应', exact: true }).click();
    await page.getByRole('button', { name: '⭐ 收藏', exact: true }).click();
    await first
      .getByRole('button', { name: '⭐ 收藏 · 1 位成员', exact: true })
      .waitFor();
    assert.equal(
      await first
        .getByRole('button', { name: '👍 · 1 位成员', exact: true })
        .count(),
      1,
    );
    await page.screenshot({ path: '/tmp/group-chat-bookmark-reaction.png' });
    await first
      .getByRole('button', { name: '⭐ 收藏 · 1 位成员', exact: true })
      .click();
    await first
      .getByRole('button', { name: '⭐ 收藏 · 1 位成员', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-chat-turn]').count(), 82);
    assert.ok(fileScopes.includes('thread'));
    messages.push({
      ...messages[0],
      id: 'agentui000000001',
      sequence: String(messages.length + 1),
      revision: String(++revision),
      senderId: 'bot0000000000001',
      senderKind: 'agent',
      text: '选择下一步',
      ui: {
        title: '下一步建议',
        html: '<button data-ui-send=\'{"action":"research"}\'>开始调研</button><button onclick="window.IntelligentUI.send({action: \'summarize\'})">整理摘要</button>',
      },
    });
    const ui = page.frameLocator('[data-chat-turn="agentui000000001"] iframe');
    await ui.getByRole('button', { name: '开始调研' }).waitFor();
    const uiFrame = await (
      await page
        .locator('[data-chat-turn="agentui000000001"] iframe')
        .elementHandle()
    ).contentFrame();
    await uiFrame.evaluate(() => {
      window.acknowledgements = 0;
      window.addEventListener('message', ({ data }) => {
        if (data?.type === 'ack') window.acknowledgements++;
      });
    });
    await ui.getByRole('button', { name: '开始调研' }).click();
    await page.waitForFunction(() =>
      document.body.textContent.includes('交互结果 {"action":"research"}'),
    );
    await page
      .locator('[data-chat-turn="agentui000000001"]')
      .getByRole('status')
      .getByText('可互动', { exact: true })
      .waitFor();
    await uiFrame.waitForFunction(
      () => window.acknowledgements >= 1 && !document.body.inert,
    );
    // A message insertion may still be scrolling the frame; keyboard activation
    // avoids a coordinate race while exercising the real second interaction.
    await ui.getByRole('button', { name: '整理摘要' }).press('Enter');
    await page.waitForFunction(() =>
      document.body.textContent.includes('交互结果 {"action":"summarize"}'),
    );
    assert.equal(uiResponses.length, 2);
    assert.notEqual(uiResponses[0].body.id, uiResponses[1].body.id);
    assert.ok(
      uiResponses.every(
        (request) => request.params.messageId === 'agentui000000001',
      ),
    );
    assert.ok(!calls.some((endpoint) => endpoint.includes('respondToTool')));
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
    await page.getByRole('button', { name: '工作区面板', exact: true }).click();
    await page.getByRole('menuitem', { name: '成员', exact: true }).click();
    const membersDrawer = page.getByRole('dialog', {
      name: '成员',
      exact: true,
    });
    await membersDrawer.getByText('Room assistant', { exact: true }).waitFor();
    await membersDrawer.getByText('陈禾', { exact: true }).waitFor();
    const mobileDraft = await page.locator('textarea').inputValue();
    await membersDrawer
      .getByRole('button', { name: '提及 Room assistant', exact: true })
      .click();
    await membersDrawer.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => document.activeElement === document.querySelector('textarea'),
    );
    assert.ok((await input.inputValue()).includes('@Room assistant '));
    await input.fill(mobileDraft);
    await page.getByRole('button', { name: '工作区面板', exact: true }).click();
    await page.getByRole('menuitem', { name: '成员', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: '/tmp/group-chat-members-mobile.png',
      fullPage: false,
    });
    await membersDrawer
      .getByRole('button', { name: '添加 Agent', exact: true })
      .click();
    const mobileEditor = page.getByRole('dialog', {
      name: '添加 Agent',
      exact: true,
    });
    assert.equal(await mobileEditor.getByRole('textbox').count(), 0);
    await mobileEditor
      .getByRole('checkbox', { name: '调研助手', exact: true })
      .check();
    await mobileEditor
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await mobileEditor.waitFor({ state: 'hidden' });
    await membersDrawer.getByText('陈禾', { exact: true }).waitFor();
    await membersDrawer
      .getByRole('button', {
        name: '查看 Room assistant 的线程消息',
        exact: true,
      })
      .click();
    await leaderDrawer
      .getByText('执行记录 30 · thread0000000001', { exact: true })
      .waitFor();
    const mobileRect = await agentDrawer.boundingBox();
    const membersRect = await membersDrawer.boundingBox();
    assert.ok(mobileRect.width <= membersRect.width);
    assert.ok(mobileRect.height <= membersRect.height);
    assert.ok(mobileRect.x >= membersRect.x && mobileRect.y >= membersRect.y);
    assert.equal(
      await membersDrawer.locator('[data-agent-thread-drawer]').count(),
      1,
    );
    await page.screenshot({ path: '/tmp/group-chat-agent-thread-mobile.png' });
    await page.keyboard.press('Escape');
    await agentDrawer.waitFor({ state: 'hidden' });
    await membersDrawer.getByText('陈禾', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1);
    await membersDrawer
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await membersDrawer.waitFor({ state: 'hidden' });
    assert.equal(await input.inputValue(), '切换和刷新后仍然保留的草稿');
    await page.screenshot({
      path: '/tmp/group-chat-mobile.png',
      fullPage: false,
    });
    await page.setViewportSize({ width: 1100, height: 820 });
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
    assert.equal(await page.locator('aside').count(), 1);
    await page.getByRole('button', { name: '文件管理', exact: true }).click();
    for (let i = 0; i < 50 && !fileScopes.includes('shared'); i++)
      await page.waitForTimeout(100);
    assert.ok(fileScopes.includes('shared'));
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
    await input.fill('个人房间切换保留草稿');
    await page
      .getByRole('combobox', { name: '切换聊天室', exact: true })
      .click();
    await page.getByRole('option', { name: /共享调研/ }).click();
    await page.waitForURL(/roomId=joined0000000001/);
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(
      await page.getByText('个人聊天室消息', { exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: '3 位成员', exact: true }).click();
    const joinedRoster = page.getByRole('complementary', {
      name: '成员',
      exact: true,
    });
    await joinedRoster.getByText('陈禾', { exact: true }).waitFor();
    assert.equal(
      await joinedRoster
        .getByRole('button', { name: '添加成员', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await joinedRoster
        .getByRole('button', { name: '添加 Agent', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await joinedRoster
        .getByRole('button', { name: '添加 A2A 成员', exact: true })
        .count(),
      0,
    );
    await page.reload();
    await input.waitFor();
    assert.match(page.url(), /roomId=joined0000000001/);
    assert.equal(
      await page.getByText('个人聊天室消息', { exact: true }).count(),
      0,
    );
    await page
      .getByRole('combobox', { name: '切换聊天室', exact: true })
      .click();
    await page.getByRole('option', { name: /我的聊天室/ }).click();
    await page
      .locator('[data-chat-turn]')
      .getByText('个人聊天室消息', { exact: true })
      .waitFor();
    assert.equal(await input.inputValue(), '个人房间切换保留草稿');
    await page.getByRole('button', { name: '2 位成员', exact: true }).click();
    const personalRoster = page.getByRole('complementary', {
      name: '成员',
      exact: true,
    });
    await personalRoster
      .getByRole('button', { name: '添加成员', exact: true })
      .click();
    const personalMemberEditor = page.getByRole('dialog', {
      name: '添加成员',
      exact: true,
    });
    await personalMemberEditor.getByRole('textbox').fill('许晴');
    await personalMemberEditor.getByRole('button', { name: /许晴/ }).click();
    await personalMemberEditor
      .getByRole('button', { name: '添加成员', exact: true })
      .click();
    await personalMemberEditor.waitFor({ state: 'hidden' });
    await personalRoster.getByText('许晴', { exact: true }).waitFor();
    assert.deepEqual(memberAdds[1], {
      params: { roomId: 'personal00000001' },
      body: { userId: 'grace' },
    });
    assert.equal(await input.inputValue(), '个人房间切换保留草稿');
    // Each API key has its own visible member identity and an ephemeral secret.
    const a2aEditor = page.getByRole('dialog', {
      name: '添加 A2A 成员',
      exact: true,
    });
    for (const name of ['远程研究助手', '远程核验助手']) {
      await personalRoster
        .getByRole('button', { name: '添加 A2A 成员', exact: true })
        .click();
      await a2aEditor.getByRole('textbox', { name: '显示名称' }).fill(name);
      await a2aEditor
        .getByRole('textbox', { name: 'Agent Card 描述', exact: true })
        .fill(`${name}的协作说明`);
      await a2aEditor
        .getByRole('button', { name: '创建成员与 API Key', exact: true })
        .click();
      await a2aEditor
        .getByText('请保存此 API Key，关闭后将无法再次查看。', { exact: true })
        .waitFor();
      const key = a2aEditor.locator('input[aria-label="API Key"]');
      assert.equal(a2aCreates.at(-1).body.publicOrigin, origin);
      assert.equal(a2aCreates.at(-1).body.description, `${name}的协作说明`);
      assert.match(await key.inputValue(), /^fixture_secret_a2amember/);
      assert.equal(await key.getAttribute('type'), 'password');
      assert.equal(
        await a2aEditor
          .getByRole('textbox', { name: 'Agent Card', exact: true })
          .inputValue(),
        `${origin}/api/a2a/rooms/personal00000001/.well-known/agent-card.json`,
      );
      await page.screenshot({ path: '/tmp/group-chat-a2a-key.png' });
      await a2aEditor
        .getByRole('button', { name: '已保存 Key，关闭', exact: true })
        .click();
      await a2aEditor.waitFor({ state: 'hidden' });
      assert.equal(
        await page.locator('input[aria-label="API Key"]').count(),
        0,
      );
    }
    assert.notEqual(
      roomA2aMembers('personal00000001')[0].id,
      roomA2aMembers('personal00000001')[1].id,
    );
    await personalRoster.getByText('远程研究助手', { exact: true }).waitFor();
    await personalRoster.getByText('远程核验助手', { exact: true }).waitFor();
    await personalRoster
      .getByRole('switch', { name: '启用 远程研究助手', exact: true })
      .click();
    await personalRoster
      .locator(
        '[role="switch"][aria-label="启用 远程研究助手"][aria-checked="false"]',
      )
      .waitFor();
    assert.equal(a2aUpdates.at(-1).body.enabled, false);
    await input.fill('@远程核');
    await page.getByRole('option', { name: /@远程核验助手/ }).click();
    assert.equal(await input.inputValue(), '@远程核验助手 ');
    await input.fill('个人房间切换保留草稿');
    await personalRoster
      .getByRole('button', { name: '配置 远程核验助手', exact: true })
      .click();
    const a2aEdit = page.getByRole('dialog', {
      name: '配置 A2A 成员',
      exact: true,
    });
    assert.equal(
      await a2aEdit.locator('input[aria-label="API Key"]').count(),
      0,
    );
    await a2aEdit.getByRole('textbox', { name: '显示名称' }).fill('外部核验');
    const cardDescription = a2aEdit.getByRole('textbox', {
      name: 'Agent Card 描述',
      exact: true,
    });
    assert.equal(await cardDescription.inputValue(), '远程核验助手的协作说明');
    await cardDescription.fill('协助核验项目资料并汇报结果');
    await a2aEdit.getByRole('button', { name: '保存', exact: true }).click();
    await a2aEdit.waitFor({ state: 'hidden' });
    assert.equal(a2aUpdates.at(-1).body.publicOrigin, origin);
    assert.equal(
      a2aUpdates.at(-1).body.description,
      '协助核验项目资料并汇报结果',
    );
    await personalRoster.getByText('外部核验', { exact: true }).waitFor();
    const remoteMember = roomA2aMembers('personal00000001')[1];
    messages.push({
      ...messages[0],
      id: 'a2a-message-00001',
      roomId: 'personal00000001',
      sequence: String(messages.length + 1),
      revision: String(++revision),
      senderId: remoteMember.id,
      senderKind: 'a2a',
      senderName: remoteMember.name,
      text: '外部成员已完成核验',
    });
    const remoteMessage = page.locator('[data-chat-turn="a2a-message-00001"]');
    await remoteMessage
      .getByText('外部成员已完成核验', { exact: true })
      .waitFor();
    await remoteMessage.getByText('外部核验', { exact: true }).waitFor();
    await remoteMessage.getByText('A2A', { exact: true }).waitFor();
    const remoteDraft = await input.inputValue();
    await input.fill('');
    await remoteMessage
      .getByRole('button', { name: '提及 外部核验', exact: true })
      .click();
    await page.waitForFunction(
      () => document.activeElement === document.querySelector('textarea'),
    );
    assert.equal(await input.inputValue(), '@外部核验 ');
    await input.fill(remoteDraft);
    assert.ok(!userLookups.includes(remoteMember.id));
    await personalRoster
      .getByRole('button', { name: '配置 外部核验', exact: true })
      .click();
    await a2aEdit
      .getByRole('button', { name: '撤销 API Key', exact: true })
      .click();
    await a2aEdit
      .getByRole('button', { name: '确认撤销', exact: true })
      .click();
    await a2aEdit.waitFor({ state: 'hidden' });
    await personalRoster.getByText('已撤销', { exact: true }).waitFor();
    assert.equal(
      await personalRoster
        .getByRole('switch', { name: '启用 外部核验', exact: true })
        .count(),
      0,
    );
    await remoteMessage.getByText('外部核验', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '个人房间切换保留草稿');
    await page.screenshot({ path: '/tmp/group-chat-a2a-members.png' });
    // Delete removes active and revoked members while retaining historical authors.
    await page.getByRole('button', { name: '5 位成员', exact: true }).waitFor();
    canManagePersonalMembers = false;
    await personalRoster
      .getByRole('button', { name: '删除 外部核验', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await personalRoster
        .getByRole('button', { name: '删除 远程研究助手', exact: true })
        .count(),
      0,
    );
    canManagePersonalMembers = true;
    await personalRoster
      .getByRole('button', { name: '删除 外部核验', exact: true })
      .waitFor();
    await personalRoster
      .getByRole('button', { name: '删除 外部核验', exact: true })
      .click();
    const deleteA2aDialog = page.getByRole('dialog', {
      name: '删除 A2A 成员',
      exact: true,
    });
    await deleteA2aDialog
      .getByText(
        '确定从聊天室删除「外部核验」吗？其 API Key 将永久失效，已有消息及作者名称会保留。',
        { exact: true },
      )
      .waitFor();
    await deleteA2aDialog
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await deleteA2aDialog.waitFor({ state: 'hidden' });
    assert.equal(a2aRemovals.length, 0);
    await personalRoster.getByText('外部核验', { exact: true }).waitFor();
    await personalRoster
      .getByRole('button', { name: '删除 外部核验', exact: true })
      .click();
    await page.screenshot({ path: '/tmp/group-chat-a2a-delete.png' });
    await deleteA2aDialog
      .getByRole('button', { name: '删除成员', exact: true })
      .click();
    await deleteA2aDialog.waitFor({ state: 'hidden' });
    await personalRoster
      .getByText('外部核验', { exact: true })
      .waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '4 位成员', exact: true }).waitFor();
    await remoteMessage.getByText('外部核验', { exact: true }).waitFor();
    await personalRoster
      .getByRole('switch', { name: '启用 远程研究助手', exact: true })
      .click();
    await personalRoster
      .locator(
        '[role="switch"][aria-label="启用 远程研究助手"][aria-checked="true"]',
      )
      .waitFor();
    await input.fill('@远程研究');
    await page.getByRole('option', { name: /@远程研究助手/ }).waitFor();
    await input.press('Escape');
    await personalRoster
      .getByRole('button', { name: '删除 远程研究助手', exact: true })
      .click();
    await deleteA2aDialog
      .getByRole('button', { name: '删除成员', exact: true })
      .click();
    await deleteA2aDialog.waitFor({ state: 'hidden' });
    await personalRoster
      .getByText('远程研究助手', { exact: true })
      .waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '3 位成员', exact: true }).waitFor();
    await input.fill('@远程研究 ');
    assert.equal(
      await page.getByRole('option', { name: /@远程研究助手/ }).count(),
      0,
    );
    assert.deepEqual(
      a2aRemovals.map((item) => item.params.memberId),
      [remoteMember.id, 'a2amember0000001'],
    );
    await input.fill('个人房间切换保留草稿');
    await page.reload();
    await remoteMessage.getByText('外部核验', { exact: true }).waitFor();
    await remoteMessage
      .getByText('外部成员已完成核验', { exact: true })
      .waitFor();
    assert.equal(await input.inputValue(), '个人房间切换保留草稿');
    await page.getByRole('button', { name: '3 位成员', exact: true }).waitFor();
    await page.goto(url);
    await input.waitFor();
    assert.equal(await input.inputValue(), '切换和刷新后仍然保留的草稿');
    await page.setViewportSize({ width: 1100, height: 820 });
    // Real upload queue, drawing export and screenshot crop, with isolated file transport.
    await input.fill('');
    const composer = page.locator('[data-chat-composer]');
    assert.notEqual(
      await composer
        .locator('[data-slot=input-group]')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
    await composer.locator('input[type=file]').setInputFiles({
      name: 'room-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Room attachment'),
    });
    await composer
      .getByRole('button', { name: '重新上传 room-note.txt', exact: true })
      .waitFor();
    assert.ok(
      await page
        .getByRole('button', { name: '发送消息', exact: true })
        .isDisabled(),
    );
    await composer
      .getByRole('button', { name: '重新上传 room-note.txt', exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="发送消息"]').disabled,
    );
    await composer
      .getByRole('button', { name: '添加附件', exact: true })
      .click();
    await page.getByRole('menuitem', { name: '绘图', exact: true }).click();
    const drawing = page.getByRole('dialog', { name: '绘图', exact: true });
    await drawing.locator('.tl-canvas').waitFor({ timeout: 45000 });
    const canvas = await drawing.locator('.tl-canvas').boundingBox();
    await page.mouse.move(
      canvas.x + canvas.width * 0.3,
      canvas.y + canvas.height * 0.5,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvas.x + canvas.width * 0.65,
      canvas.y + canvas.height * 0.6,
      { steps: 16 },
    );
    await page.mouse.up();
    await drawing.locator('.tl-shape[data-shape-type="draw"]').waitFor();
    await drawing.getByRole('button', { name: '完成', exact: true }).click();
    await drawing.waitFor({ state: 'hidden' });
    await composer
      .getByRole('button', { name: /^编辑绘图：drawing-/ })
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="发送消息"]').disabled,
    );
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext('2d');
        const draw = () => {
          context.fillStyle = '#348eb4';
          context.fillRect(0, 0, 640, 360);
        };
        draw();
        const stream = canvas.captureStream(20);
        const timer = setInterval(draw, 50);
        const track = stream.getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(timer);
          stop();
          window.captureStopped = true;
        };
        return stream;
      };
    });
    await composer
      .getByRole('button', { name: '添加附件', exact: true })
      .click();
    await page.getByRole('menuitem', { name: '截屏', exact: true }).click();
    const crop = page.getByRole('dialog', { name: '裁剪截图', exact: true });
    await crop.getByRole('button', { name: '裁剪并添加', exact: true }).click();
    await crop.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="发送消息"]').disabled,
    );
    assert.equal(await page.evaluate(() => window.captureStopped), true);
    assert.equal(uploadedFiles.size, 3);
    assert.equal(await input.inputValue(), '');
    await page.screenshot({ path: '/tmp/group-chat-composer-attachments.png' });
    failSend = true;
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page
      .getByText('操作失败，请重试。输入内容已保留。', { exact: true })
      .waitFor();
    assert.equal(
      await composer.getByText('room-note.txt', { exact: true }).count(),
      1,
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await composer
      .getByText('room-note.txt', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(sendIds.at(-1), sendIds.at(-2));
    const attachedMessage = messages.find(
      (message) => message.id === sendIds.at(-1),
    );
    assert.equal(attachedMessage.files.length, 3);
    assert.ok(
      attachedMessage.files.every((file) =>
        uploadedFiles.has(file.path.replace(/^\.\//, '')),
      ),
    );
    const attachmentRow = page.locator(
      `[data-chat-turn="${attachedMessage.id}"]`,
    );
    await attachmentRow.locator('img').first().waitFor();
    await attachmentRow
      .locator('img')
      .evaluateAll((images) =>
        Promise.all(images.map((image) => image.decode())),
      );
    await page.screenshot({ path: '/tmp/group-chat-composer-sent.png' });
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
          'groupChats/create',
          'groupChats/update',
          'groupChats/remove',
        ].includes(call),
      ),
    );
    assert.deepEqual(errors, []);
  },
);
