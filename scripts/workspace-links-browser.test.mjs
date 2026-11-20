/** Real message-to-preview navigation with deterministic file transport. */
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
  'Markdown links open files, preview local web apps and link to external pages',
  { timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.workspace-links-test-'));
    let vite, browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    const localUrls = [
      'http://localhost:4173/report?tab=summary#totals',
      'http://127.0.0.1:8080/preview?mode=full#section',
    ];
    const markdown = [
      '[Code at 120](/workspace/src/app.ts:120)',
      '[Code at 30](/workspace/src/app.ts:30)',
      '[Report at 100](</workspace/My Project/My Report.md:100>)',
      '[HTML at 80](/workspace/page.html:80)',
      '[Shared at 90](../shared/shared.txt:90)',
      '[Shared guide](../shared/docs/guide/index.md)',
      '[Chat export](sandbox:/exports/季度%20报告.txt:12)',
      '[Plain file](/workspace/plain.txt)',
      '[Directory](/workspace/src/)',
      '[Website](https://example.com/guide:12)',
      `[Chat app](${localUrls[0].replace('http://', '')})`,
      '~~Removed~~',
      '| Feature | Supported |\n| --- | --- |\n| GFM | yes |',
    ].join('\n\n');
    const userText = [
      '**Plain text** [Open notes](sandbox:/notes/manual.txt)',
      'Example: `[Sample](sandbox:/skip.txt)`',
    ].join('\n');
    const sharedDocuments = {
      'docs/guide/index.md': [
        '# Shared guide',
        '[Next page](../chapters/中文%20说明.md)',
        '[Sandbox report](sandbox:/reports/季度%20报告.md)',
        '[HTTP guide](http://example.com/guide)',
        '[HTTPS guide](https://example.com/guide)',
        ...localUrls.map((url) => `[Preview ${new URL(url).hostname}](${url})`),
      ].join('\n\n'),
      'docs/chapters/中文 说明.md': '# Chapter\n\n[Browse assets](assets)',
      'docs/guide/reports/季度 报告.md': '# Quarterly report',
    };
    const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {createRouter,createRootRoute,createMemoryHistory,RouterProvider} from '@tanstack/react-router';
import {ChatWorkspace} from '/src/components/chat/chat-workspace';
import {ChatMessages} from '/src/components/chat/chat-messages';
import {MessageResponse} from '/src/components/ai-elements/message';
import {RoomMessage} from '/src/pages/group-chats/components/room-message';
import {ThreadFilePreview} from '/src/components/chat/message-preview/thread-file-preview';
import {WorkspaceFileContext} from '/src/components/file-manager/context';
import {filesApi} from '/src/components/file-manager/api';
import {SessionContext} from '/src/features/auth/session-context';
import {PluginContext} from '/src/features/plugins/context';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {initializeI18n} from '/src/i18n';
import '/src/index.css';
window.fileCalls=[];
const markdown=${JSON.stringify(markdown)};
const userText=${JSON.stringify(userText)};
const sharedDocuments=${JSON.stringify(sharedDocuments)};
filesApi.resolve=async(threadId,path)=>{
  window.fileCalls.push({operation:'resolve',threadId,path});
  const scope=path.startsWith('../shared/')?'shared':'thread';
  const relative=path.replace(/^\\/workspace\\//,'').replace(/^\\.\\.\\/shared\\//,'').replace(/\\/$/,'');
  return {scope,kind:path.endsWith('/')||relative==='docs/chapters/assets'?'directory':'file',path:relative};
};
filesApi.list=async(_threadId,path,_signal,scope)=>({
  entries:scope==='shared' && path==='docs/chapters/assets' ? [{path:path+'/image.png',name:'image.png',kind:'file'}] : [],
  truncated:false,
});
filesApi.preview=async(threadId,path,_signal,scope)=>{
  window.fileCalls.push({operation:'preview',threadId,path,scope});
  const text=(scope==='shared' && sharedDocuments[path]) || Array.from({length:180},(_,i)=>'line '+(i+1)).join('\\n');
  return {path,kind:'text',text,mime:path.endsWith('.html')?'text/html':'text/plain',size:text.length,modifiedAt:'fixture',version:'fixture'};
};
const group=new URLSearchParams(location.search).has('room');
const fromUser=new URLSearchParams(location.search).has('user');
const readOnly=new URLSearchParams(location.search).has('readonly');
function Message(){
  if (!group && fromUser) return <ChatMessages threadId="bot-thread" messages={[{id:'user-message',role:'user',parts:[{type:'text',text:userText}]}]} running={false} activeMessageId={null}/>;
  return group?<RoomMessage message={{id:'message',roomId:'room',sequence:'1',revision:'1',senderId:fromUser?'alice':'bot',senderKind:fromUser?'user':'agent',text:fromUser?userText:markdown,files:[],reactions:[],createdAt:'2026-11-01T00:00:00Z'}} userId="alice" label={fromUser?'Alice':'Bot'} onReply={()=>{}} onJumpToReply={()=>{}} loadingReply={false} onReact={async()=>{}} onRespondUi={async()=>{}} onRespondChoices={async()=>{}}/>:<MessageResponse mode="static">{markdown}</MessageResponse>;
}
function App(){
  const [file,setFile]=React.useState(null);
  const message=<section className="p-5" data-testid="message"><Message/></section>;
  return <main className="flex h-dvh min-h-0 flex-col">{readOnly?<WorkspaceFileContext.Provider value={(path,_kind,line)=>setFile({path,line})}><div className="grid h-full min-h-0 grid-cols-2">{message}<section data-testid="readonly" className="min-h-0">{file&&<ThreadFilePreview key={file.path} threadId="bot-thread" path={file.path} line={file.line}/>}</section></div></WorkspaceFileContext.Provider>:<ChatWorkspace threadId="bot-thread">{message}</ChatWorkspace>}</main>;
}
await initializeI18n();
const router=createRouter({routeTree:createRootRoute({component:App}),history:createMemoryHistory({initialEntries:['/']})});
createRoot(document.getElementById('root')).render(<ThemeProvider><SessionContext.Provider value={{data:{user:{id:'alice'},session:{id:'session'}}}}><PluginContext.Provider value={{plugins:[],loading:false,error:false}}><RouterProvider router={router}/></PluginContext.Provider></SessionContext.Provider></ThemeProvider>);`;
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
          name: 'workspace-links-fixture',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (new URL(req.url, 'http://fixture').pathname !== '/')
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
      viewport: { width: 1400, height: 800 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const url = 'http://127.0.0.1:' + vite.httpServer.address().port;
    const link = (name) =>
      page.getByTestId('message').getByRole('link', { name, exact: true });
    async function assertLine(line) {
      await page.waitForFunction((line) => {
        const code = [...document.querySelectorAll('code')].find(
          (el) =>
            el.textContent === 'line ' + line &&
            el.parentElement.classList.contains('bg-accent'),
        );
        if (!code) return false;
        const viewport = code.closest('[data-slot="scroll-area-viewport"]');
        const a = code.getBoundingClientRect(),
          b = viewport.getBoundingClientRect();
        return a.top >= b.top && a.bottom <= b.bottom && b.height > 0;
      }, line);
    }
    for (const query of ['', '?room']) {
      await page.goto(url + '/' + query);
      await link('Chat export').click();
      await assertLine(12);
      assert.deepEqual(
        await page.evaluate(() =>
          window.fileCalls.find((call) => call.operation === 'preview'),
        ),
        {
          operation: 'preview',
          threadId: 'bot-thread',
          path: 'exports/季度 报告.txt',
          scope: 'thread',
        },
      );
      await link('Code at 120').click();
      await assertLine(120);
      assert.equal(
        await link('Code at 120').getAttribute('title'),
        '/workspace/src/app.ts:120',
      );
      assert.equal(
        await page.getByTestId('message').getByRole('table').count(),
        1,
      );
      assert.equal(
        await page.getByTestId('message').locator('del').textContent(),
        'Removed',
      );
      assert.equal(
        await link('Website').getAttribute('href'),
        'https://example.com/guide:12',
      );
      assert.equal(await link('Website').getAttribute('target'), '_blank');

      await link('Code at 30').click();
      await assertLine(30);
      await page
        .locator('[data-slot="scroll-area-viewport"]')
        .evaluateAll((nodes) =>
          nodes.forEach((node) => {
            node.scrollTop = 0;
          }),
        );
      await link('Code at 30').click();
      await assertLine(30);

      await link('Report at 100').click();
      await assertLine(100);
      assert.equal(
        await page
          .getByRole('tab', { name: '原文', exact: true })
          .getAttribute('aria-selected'),
        'true',
      );
      await page.getByRole('tab', { name: '渲染预览', exact: true }).click();
      await link('Report at 100').click();
      await assertLine(100);
      assert.equal(
        await page
          .getByRole('tab', { name: '原文', exact: true })
          .getAttribute('aria-selected'),
        'true',
      );

      await link('HTML at 80').click();
      await assertLine(80);
      await page.getByRole('tab', { name: '渲染预览', exact: true }).click();
      await link('HTML at 80').click();
      await assertLine(80);

      await link('Shared at 90').click();
      await assertLine(90);
      const calls = await page.evaluate(() => window.fileCalls);
      assert.ok(
        calls.some(
          (call) =>
            call.operation === 'preview' &&
            call.path === 'shared.txt' &&
            call.scope === 'shared',
        ),
      );
      assert.ok(
        calls.some(
          (call) =>
            call.operation === 'preview' &&
            call.path === 'My Project/My Report.md',
        ),
      );
      assert.ok(
        calls.every((call) => !/:\d+$/.test(call.path)),
        'line numbers must never reach file APIs as part of the path',
      );

      await link('Plain file').click();
      await page.getByRole('tab', { name: 'plain.txt', exact: true }).waitFor();
      await page
        .locator('code:visible')
        .filter({ hasText: /^line 1$/ })
        .waitFor();
      await link('Directory').click();
      await page.waitForFunction(() =>
        window.fileCalls.some(
          (call) =>
            call.operation === 'resolve' && call.path === '/workspace/src',
        ),
      );
    }
    for (const query of ['?user', '?user&room']) {
      await page.goto(url + '/' + query);
      await link('Open notes').click();
      await page
        .getByRole('tab', { name: 'manual.txt', exact: true })
        .waitFor();
      assert.equal(await link('Sample').count(), 0);
      const messageText = await page.getByTestId('message').innerText();
      assert.ok(messageText.includes('**Plain text**'));
      assert.ok(messageText.includes('[Sample](sandbox:/skip.txt)'));
    }
    await page.goto(url);
    const navigationCalls = [];
    await page.route('**/api/rpc/threads/browser/action', (route) => {
      const { params, body } = route.request().postDataJSON().json;
      if (body.kind === 'navigate')
        navigationCalls.push({ threadId: params.threadId, url: body.url });
      return route.fulfill({ json: {} });
    });
    await page.route('**/api/rpc/threads/browser/state', (route) =>
      route.fulfill({
        json: {
          json: {
            status: 'waiting',
            url: '',
            tabs: [],
            activeTabIndex: 0,
            busy: false,
          },
        },
      }),
    );
    const documentLink = (name) =>
      page.locator('article').getByRole('link', { name, exact: true });
    const panel = page.getByRole('region', { name: '浏览器', exact: true });
    async function expectPanelNavigation(anchor, target) {
      const count = navigationCalls.length;
      const [response] = await Promise.all([
        page.waitForResponse(
          (res) =>
            res.url().endsWith('/api/rpc/threads/browser/action') &&
            res.request().postDataJSON().json.body.kind === 'navigate',
        ),
        anchor.click(),
      ]);
      assert.ok(response.ok());
      await panel.getByRole('textbox', { name: '输入网址' }).waitFor();
      assert.deepEqual(navigationCalls.slice(count), [
        { threadId: 'bot-thread', url: target },
      ]);
      assert.equal(page.context().pages().length, 1);
    }
    for (const target of localUrls) {
      await page
        .context()
        .route(target.split('#')[0], (route) => route.abort());
      await link('Shared guide').click();
      await expectPanelNavigation(
        documentLink('Preview ' + new URL(target).hostname),
        target,
      );
    }
    await expectPanelNavigation(link('Chat app'), localUrls[0]);
    await link('Shared guide').click();
    const callsBeforeRemote = navigationCalls.length;
    const remoteUrl = 'https://example.com/guide';
    await page.context().route(remoteUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<title>Guide</title>',
      }),
    );
    const [remotePage] = await Promise.all([
      page.context().waitForEvent('page'),
      documentLink('HTTPS guide').click(),
    ]);
    await remotePage.waitForURL(remoteUrl);
    assert.equal(await remotePage.title(), 'Guide');
    await remotePage.close();
    await page.getByRole('heading', { name: 'Shared guide' }).waitFor();
    assert.equal(navigationCalls.length, callsBeforeRemote);
    await page.goto(url + '/?readonly');
    await link('Report at 100').click();
    await assertLine(100);
    await link('HTML at 80').click();
    await assertLine(80);
    await page.screenshot({ path: '/tmp/workspace-file-links-readonly.png' });
    const preview = page.getByTestId('readonly');
    await link('Shared guide').click();
    await preview.getByRole('heading', { name: 'Shared guide' }).waitFor();
    for (const protocol of ['http', 'https']) {
      const external = preview.getByRole('link', {
        name: protocol.toUpperCase() + ' guide',
        exact: true,
      });
      assert.equal(
        await external.getAttribute('href'),
        protocol + '://example.com/guide',
      );
      assert.equal(await external.getAttribute('target'), '_blank');
    }
    await preview.getByRole('link', { name: 'Next page' }).click();
    await preview.getByRole('heading', { name: 'Chapter' }).waitFor();
    await preview.getByRole('link', { name: 'Browse assets' }).click();
    await preview.getByRole('button', { name: 'image.png' }).waitFor();
    await link('Shared guide').click();
    await preview.getByRole('link', { name: 'Sandbox report' }).click();
    await preview.getByRole('heading', { name: 'Quarterly report' }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(url + '/?room');
    await link('Code at 120').click();
    await assertLine(120);
    await page.screenshot({ path: '/tmp/workspace-file-links-mobile.png' });
    assert.deepEqual(errors, []);
  },
);
