/** Run with node --import tsx scripts/fixtures/realtime-browser.mjs; inspect the printed URL in a browser. */
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { realtimeRoutes } from '../../apps/server/src/modules/realtime/routes.ts';
import { eventStream } from '../../apps/server/src/modules/threads/event-stream.ts';

const webRoot = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const serverRequire = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
const { Hono } = serverRequire('hono');
const { getRequestListener } = serverRequire('@hono/node-server');
const { createServer } = await import(
  pathToFileURL(webRequire.resolve('vite')).href
);
const { default: react } = await import(
  pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href
);
const fixture = await mkdtemp(path.join(webRoot, '.realtime-test-'));
process.once('exit', () => rmSync(fixture, { recursive: true, force: true }));
const origins = [];
const activeConnections = new Set();
const feeds = new Map();
let totalConnections = 0,
  version = 0;
const auth = {
  api: {
    getSession: async () => ({
      user: { id: 'fixture' },
      session: { id: 'fixture-session' },
    }),
  },
};
const api = new Hono();
api.route(
  '/api/realtime',
  realtimeRoutes(auth, (request) => api.fetch(request), origins),
);
const feed = (c) => {
  const id = crypto.randomUUID();
  const url = c.req.path;
  const kind = url.includes('/notifications/')
    ? 'notification'
    : url.endsWith('/threads/events')
      ? 'navigation'
      : url.endsWith('/browser/events')
        ? 'state'
        : 'snapshot';
  return eventStream(
    c.req.raw.signal,
    (send) => {
      feeds.set(id, { url, kind, send });
      send(kind, { url, version });
      return () => feeds.delete(id);
    },
    async () => undefined,
  );
};
api.get('/api/threads/*', feed);
api.get('/api/notifications/events', feed);
api.get('/api/test/metrics', (c) =>
  c.json({
    connections: activeConnections.size,
    totalConnections,
    feeds: feeds.size,
    version,
  }),
);
api.post('/api/test/drop', (c) => {
  for (const abort of activeConnections) abort.abort();
  return c.json({ ok: true });
});
api.post('/api/test/publish', (c) => {
  version++;
  for (const { url, kind, send } of feeds.values())
    send(kind === 'snapshot' ? 'update' : kind, { url, version });
  return c.json({ version });
});
api.get('/api/test/image.svg', (c) =>
  c.body(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#176b48"/><text x="12" y="50" fill="white">Image loaded</text></svg>',
    200,
    { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
  ),
);
const server = httpServer(
  getRequestListener(async (request) => {
    if (
      request.method === 'GET' &&
      new URL(request.url).pathname.startsWith('/api/realtime/')
    ) {
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, request.signal]);
      activeConnections.add(abort);
      totalConnections++;
      signal.addEventListener('abort', () => activeConnections.delete(abort), {
        once: true,
      });
      return api.fetch(new Request(request, { signal }));
    }
    return api.fetch(request);
  }),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await writeFile(
  path.join(fixture, 'entry.ts'),
  `
import { SharedEventSource } from '/src/components/realtime/event-source';
const query = new URLSearchParams(location.search);
if(query.has('fallback')) Object.defineProperty(window,'SharedWorker',{value:undefined});
const number = query.get('tab') || '1';
const threadId = 'chat'+number.padStart(12,'0');
document.querySelector('#identity').textContent = '聊天 '+number+' · '+(query.has('fallback')?'Web Locks 备用通道':'SharedWorker');
const sources = new Map(); const counts = {}; let log=[];
function subscribe(key,url){
 const source = new SharedEventSource(url,'fixture-session'); sources.set(key,source);
 for(const name of ['snapshot','update','navigation','notification','state','expired','revoked','error']) source.addEventListener(name,(event)=>{
  counts[key]=(counts[key]||0)+1;
  log.push(key+' '+name+' '+(event.data||'')); log=log.slice(-12);
  document.querySelector('#events').textContent=log.join('\\n');
  document.querySelector('#counts').textContent=JSON.stringify(counts);
 });
}
subscribe('navigation','/api/threads/events');
subscribe('notifications','/api/notifications/events');
const chat=()=>subscribe('chat','/api/threads/'+threadId+'/messages?view=summary');chat();
document.querySelector('#close').onclick=()=>{sources.get('chat')?.close();sources.delete('chat');document.querySelector('#state').textContent='聊天订阅已关闭';};
document.querySelector('#open').onclick=()=>{if(!sources.has('chat'))chat();document.querySelector('#state').textContent='聊天订阅已开启';};
document.querySelector('#drop').onclick=()=>fetch('/api/test/drop',{method:'POST'});
document.querySelector('#publish').onclick=()=>fetch('/api/test/publish',{method:'POST'});
document.querySelector('#metrics').onclick=async()=>{document.querySelector('#status').textContent=JSON.stringify(await(await fetch('/api/test/metrics')).json());};
document.querySelector('#load').onclick=async()=>{
 const start=performance.now();document.querySelector('#result').textContent='加载中';
 await import('/src/components/file-manager/file-manager.tsx');
 const img=document.querySelector('img');img.src='/api/test/image.svg?'+Date.now();await img.decode();
 document.querySelector('#result').textContent='文件模块与图片已加载 · '+Math.round(performance.now()-start)+' ms';
};
`,
);
const html = `<!doctype html><meta charset="utf-8"><title>SSE 多标签回归验证</title><style>body{font:16px system-ui;margin:32px;background:#11251b;color:#d7f1e2}button,a{padding:10px;margin:4px;color:inherit;background:#28543e;border:1px solid #47745b;border-radius:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;background:#183523}img{display:block;margin-top:16px}</style><h1>SSE 多标签回归验证</h1><h2 id="identity"></h2><p id="counts"></p><p id="state">聊天订阅已开启</p><button id="metrics">读取连接数</button><button id="publish">广播更新</button><button id="drop">模拟服务断线</button><button id="close">关闭聊天订阅</button><button id="open">重新订阅聊天</button><button id="load">加载文件模块和图片</button><p id="status"></p><p id="result"></p><img alt="验证图片"><pre id="events"></pre><script type="module" src="/${path.basename(fixture)}/entry.ts"></script>`;
const vite = await createServer({
  configFile: false,
  envFile: false,
  root: webRoot,
  cacheDir: path.join(fixture, 'node_modules/.vite'),
  resolve: {
    alias: { '@': path.join(webRoot, 'src') },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: { exclude: ['@tldraw/assets'] },
  plugins: [
    react(),
    {
      name: 'realtime-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (new URL(req.url, 'http://test').pathname !== '/realtime-test')
            return next();
          void server.transformIndexHtml(req.url, html).then((output) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(output);
          });
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${server.address().port}` },
  },
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
origins.push(origin);
console.log('Fixture:', origin + '/realtime-test?tab=1');
console.log('Fallback:', origin + '/realtime-test?tab=1&fallback=1');
console.log('Metrics:', origin + '/api/test/metrics');
async function close() {
  for (const abort of activeConnections) abort.abort();
  await vite.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
