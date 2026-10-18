/** Isolated visual fixture. No database, credentials, model calls, or production API proxy. */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const requireWeb = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const load = (name) => import(pathToFileURL(requireWeb.resolve(name)).href);
const [{ createServer }, { default: react }, { default: tailwindcss }] =
  await Promise.all([
    load('vite'),
    load('@vitejs/plugin-react'),
    load('@tailwindcss/vite'),
  ]);
const stamp = '2026-10-13T08:00:00.000Z';
const settings = {
  model: 'preview/model',
  reasoningEffort: 'auto',
  agentId: null,
};
const threads = [
  '整理产品发布计划',
  '从需求到可执行的开发方案',
  '研究资料与阅读笔记',
].map((title, index) => ({
  ...settings,
  id: `preview-thread-${index + 1}`,
  title,
  status: 'idle',
  queueCount: 0,
  error: null,
  createdAt: stamp,
  updatedAt: stamp,
  projectId: null,
}));
const projects = ['产品设计工作室', '团队知识库', '开源项目研究'].map(
  (name, index) => ({
    id: `previewproject0${index + 1}`,
    name,
    role: index ? 'member' : 'owner',
    pinned: !index,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
  }),
);
const messages = [
  {
    id: 'preview-user',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: '为产品发布整理一份行动计划，覆盖体验、文档与团队协作。',
      },
    ],
  },
  {
    id: 'preview-assistant',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: '### 让发布准备更有条理\n\n围绕三个方向推进，为每一步保留可检查的成果。\n\n| 方向 | 重点工作 | 交付成果 |\n| --- | --- | --- |\n| 产品体验 | 主流程、移动端与深色模式 | 体验验收记录 |\n| 使用文档 | 安装步骤与产品截图 | 更新后的 README |\n| 团队协作 | 负责人确认与发布前检查 | 共享任务清单 |',
      },
    ],
  },
];
const turn = {
  id: messages[0].id,
  user: messages[0],
  assistant: messages[1],
  toolCount: 0,
  revision: 'preview',
  assetRevision: '',
};
const model = {
  id: 'model',
  providerId: 'preview',
  name: 'workspace-model',
  displayName: 'Workspace Model',
  description: '示例模型',
  modelType: 'language',
  enabled: true,
  modalitiesInput: ['text', 'image'],
  modalitiesOutput: ['text'],
  reasoning: true,
  toolCall: true,
  limitContext: 128000,
  limitOutput: 16000,
};
const catalog = {
  providers: [
    {
      id: 'preview',
      name: '模型服务',
      type: 'openai-compatible',
      enabled: true,
      models: [model],
    },
  ],
  defaults: { defaultModel: settings.model, thinkingMode: 'medium' },
};
const routes = {
  'providers/available': catalog,
  'threads/preferences': settings,
  'threads/list': { threads, page: 0, hasMore: false },
  'threads/get': { thread: threads[0] },
  'threads/history': {
    messages,
    page: 0,
    hasMore: false,
    total: messages.length,
  },
  'threads/skills': { skills: [] },
  'projects/list': { projects, page: 0, hasMore: false },
  'agents/available': { agents: [], defaultAgentId: null },
  'files/list': { entries: [], truncated: false },
  'assets/list': { assets: [], hasMore: false },
};
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../apps/web', import.meta.url)),
  envFile: false,
  cacheDir: fileURLToPath(
    new URL('../node_modules/.vite-product-preview', import.meta.url),
  ),
  resolve: {
    alias: { '@': fileURLToPath(new URL('../apps/web/src', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'isolated-product-preview',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const url = new URL(req.url, 'http://127.0.0.1:5174');
          if (!url.pathname.startsWith('/api/')) return next();
          res.setHeader('Cache-Control', 'no-store');
          if (
            url.pathname.includes('/events') ||
            url.pathname.endsWith('/messages')
          ) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              Connection: 'keep-alive',
            });
            if (url.pathname.endsWith('/messages'))
              res.write(
                `event: snapshot\ndata: ${JSON.stringify(
                  url.searchParams.get('view') === 'summary'
                    ? {
                        thread: threads[0],
                        turns: [turn],
                        activeMessageId: null,
                        activeTurnId: null,
                        canContinue: false,
                        history: { cursor: null, hasMore: false },
                      }
                    : { thread: threads[0], messages, activeMessageId: null },
                )}\n\n`,
              );
            else if (url.pathname === '/api/threads/events')
              res.write(
                `event: navigation\ndata: ${JSON.stringify({ type: 'snapshot', threads, projects, archivedThreads: [] })}\n\n`,
              );
            else res.write(': preview\n\n');
            const timer = setInterval(
              () => res.write(': keepalive\n\n'),
              15000,
            );
            res.on('close', () => clearInterval(timer));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          if (url.pathname === '/api/auth/get-session')
            return res.end(
              JSON.stringify({
                user: {
                  id: 'preview-user',
                  name: '体验空间',
                  username: 'preview',
                  email: 'preview@example.test',
                  role: 'admin',
                  emailVerified: true,
                  createdAt: stamp,
                  updatedAt: stamp,
                },
                session: {
                  id: 'preview-session',
                  userId: 'preview-user',
                  expiresAt: '2099-01-01T00:00:00.000Z',
                  createdAt: stamp,
                  updatedAt: stamp,
                },
              }),
            );
          const route = url.pathname.replace('/api/rpc/', '');
          if (route === 'threads/turn')
            return res.end(
              JSON.stringify({
                json: { id: turn.id, revision: turn.revision, messages },
              }),
            );
          if (route in routes)
            return res.end(JSON.stringify({ json: routes[route] }));
          console.log(`Unconfigured preview request: ${url.pathname}`);
          res.statusCode = 501;
          res.end(
            JSON.stringify({
              json: {
                code: 'PREVIEW_READ_ONLY',
                status: 501,
                message: 'This isolated preview does not execute operations.',
              },
            }),
          );
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
await server.listen();
console.log('Read-only product preview: http://127.0.0.1:5174');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
