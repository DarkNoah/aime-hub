/** Production components in Chromium; APIs are local fixtures, no model calls. */
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
  'image cards annotate, undo, export, reopen, send and recover from load failures',
  { timeout: 180000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.image-edit-test-'));
    let vite, browser, page;
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
import {Toaster} from 'sonner';
import {ChatConversation} from '/src/components/chat/chat-conversation';
import {ChatComposer} from '/src/components/chat/chat-composer';
import {ChatMessageAttachments} from '/src/components/chat/chat-message-attachments';
import {ChatToolAttachments} from '/src/components/chat/chat-tool-attachments';
import {PersonalChatSettingsProvider} from '/src/components/chat/personal-chat-settings-provider';
import {SessionContext} from '/src/features/auth/session-context';
import {AvailableModelsProvider} from '/src/features/models/available-models-provider';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {initializeI18n} from '/src/i18n';
import '/src/index.css';
const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=360;
const ctx=canvas.getContext('2d'); ctx.fillStyle='#f3f4f6'; ctx.fillRect(0,0,640,340);
ctx.fillStyle='#166534'; ctx.fillRect(60,60,160,100); ctx.font='28px sans-serif'; ctx.fillText('Image annotation',60,230);
window.original=canvas.toDataURL('image/png'); window.sent=[];
function App(){
  const [source,setSource]=React.useState(window.original); window.setSource=setSource;
  return <div style={{height:'100dvh',maxWidth:900,margin:'auto'}}><ChatConversation composer={<ChatComposer threadId="fixture-thread" onSend={async(input)=>{window.sent.push(input)}}/>}>
    <ChatMessageAttachments attachments={[{id:'source',type:'file',mediaType:'image/png',filename:'source.png',url:source}]}/>
    <ChatToolAttachments tools={[{type:'dynamic-tool',toolName:'custom_tool',toolCallId:'image',state:'output-available',input:{},output:{file_path:'outputs/images/tool.png',content:[{type:'image',mimeType:'image/png',data:window.original.split(',')[1]}]}}]}/>
  </ChatConversation><Toaster/></div>
}
await initializeI18n();
createRoot(document.getElementById('root')).render(<React.StrictMode><ThemeProvider><SessionContext.Provider value={{data:{user:{id:'fixture-user'},session:{id:'fixture-session'}},isPending:false}}><AvailableModelsProvider><PersonalChatSettingsProvider><App/></PersonalChatSettingsProvider></AvailableModelsProvider></SessionContext.Provider></ThemeProvider></React.StrictMode>);
`,
    );
    const routes = {
      'threads/preferences': {
        model: null,
        reasoningEffort: 'auto',
        agentId: null,
      },
      'providers/available': { providers: [], defaults: {} },
      'agents/available': { agents: [], defaultAgentId: null },
      'threads/skills': { skills: [] },
      'files/list': { entries: [], truncated: false },
    };
    const sessions = new Map();
    const uploaded = [];
    let failNextUpload = false;
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
          name: 'image-edit-test',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              const pathname = req.url?.split('?')[0];
              const uploadRoute = pathname?.match(
                /^\/api\/threads\/fixture-thread\/files\/uploads(?:\/([^/]+))?(\/complete)?$/,
              );
              if (uploadRoute) {
                res.setHeader('Content-Type', 'application/json');
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = Buffer.concat(chunks);
                if (req.method === 'POST' && !uploadRoute[1]) {
                  if (failNextUpload) {
                    failNextUpload = false;
                    res.statusCode = 400;
                    res.end(JSON.stringify({ code: 'FILE_UPLOAD_FAILED' }));
                    return;
                  }
                  const request = JSON.parse(body.toString());
                  const id = String(sessions.size + 1);
                  sessions.set(id, { ...request, chunks: [] });
                  res.end(
                    JSON.stringify({ id, offset: 0, chunkSize: 1024 * 1024 }),
                  );
                } else if (req.method === 'PUT') {
                  const session = sessions.get(uploadRoute[1]);
                  session.chunks.push(body);
                  res.end(
                    JSON.stringify({
                      offset: Buffer.concat(session.chunks).length,
                    }),
                  );
                } else if (uploadRoute[2]) {
                  const session = sessions.get(uploadRoute[1]);
                  uploaded.push({
                    path: session.path,
                    data: Buffer.concat(session.chunks),
                  });
                  res.end(JSON.stringify({ path: session.path }));
                } else res.end('{}');
                return;
              }
              if (pathname?.startsWith('/api/')) {
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({
                    json: routes[pathname.replace('/api/rpc/', '')] ?? {},
                  }),
                );
                return;
              }
              if (pathname !== '/') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await server.transformIndexHtml(
                  '/',
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="/' +
                    path.relative(webRoot, path.join(fixture, 'entry.tsx')) +
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
    page = await browser.newPage({
      viewport: { width: 1100, height: 850 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto('http://127.0.0.1:' + vite.httpServer.address().port);
      const sourceEdit = page.getByRole('button', {
        name: '编辑图片：source.png',
        exact: true,
      });
      await sourceEdit.waitFor();
      const toolEdit = page.getByRole('button', {
        name: '编辑图片：tool.png',
        exact: true,
      });
      assert.equal(
        await toolEdit.evaluate((button) => button.nextElementSibling?.tagName),
        'A',
        'edit sits beside download',
      );
      await page.screenshot({ path: '/tmp/chat-image-edit-cards.png' });
      await page.locator('textarea').fill('保留已有草稿');
      await sourceEdit.click();
      const complete = page.getByRole('button', {
        name: '完成',
        exact: true,
      });
      await complete.waitFor();
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent === '完成',
          )?.disabled,
      );
      assert.equal(await page.getByRole('dialog').count(), 1);
      const completeBox = await complete.boundingBox();
      const closeBox = await page
        .getByRole('button', { name: '关闭绘画板', exact: true })
        .boundingBox();
      assert.ok(
        Math.abs(completeBox.y - closeBox.y) <= 1 &&
          closeBox.x - (completeBox.x + completeBox.width) <= 10,
        'complete sits beside close',
      );
      // Draw using the real pointer tools, not editor state injection.
      const image = page.locator('img.tl-image').first();
      await image.waitFor();
      await image.evaluate((img) => img.decode());
      // Wait for tldraw's initial zoom to paint before choosing page coordinates.
      await image.scrollIntoViewIfNeeded();
      const box = await image.boundingBox();
      assert.ok(box?.width > 100);
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width * 0.75,
        box.y + box.height * 0.5,
        { steps: 18 },
      );
      await page.mouse.up();
      await page.locator('.tl-shape[data-shape-type="draw"]').waitFor();
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(
        () => !document.querySelector('.tl-shape[data-shape-type="draw"]'),
      );
      assert.equal(
        await page.locator('img.tl-image').count(),
        1,
        'undo preserves the base image',
      );
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await page.locator('.tl-shape[data-shape-type="draw"]').waitFor();
      await page.screenshot({ path: '/tmp/chat-image-edit-desktop.png' });
      await complete.click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      const attachment = page.getByRole('button', {
        name: /^编辑绘图：annotated-/,
      });
      await attachment.waitFor();
      assert.equal(await page.locator('textarea').inputValue(), '保留已有草稿');
      const result = await attachment.locator('img').evaluate(async (img) => {
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] > 150 &&
            pixels[i] > pixels[i + 1] * 1.4 &&
            pixels[i] > pixels[i + 2] * 1.4
          )
            red++;
        return {
          width: canvas.width,
          height: canvas.height,
          red,
          corner: Array.from(ctx.getImageData(0, 359, 1, 1).data),
          green: Array.from(ctx.getImageData(80, 80, 1, 1).data),
        };
      });
      assert.equal(result.width, 640);
      assert.equal(result.height, 360);
      assert.ok(result.red > 100, JSON.stringify(result));
      assert.equal(
        result.corner[3],
        0,
        'transparent source remains transparent',
      );
      assert.ok(
        result.green[1] > result.green[0],
        'original image survives export',
      );
      assert.equal(
        await page
          .locator('[data-chat-message-attachments] img')
          .getAttribute('src'),
        await page.evaluate(() => window.original),
      );
      await attachment.click();
      assert.equal(uploaded.length, 1, 'first completed image was uploaded');
      assert.equal(uploaded[0].data.subarray(1, 4).toString(), 'PNG');
      assert.equal(uploaded[0].data.readUInt32BE(16), 640);
      assert.equal(uploaded[0].data.readUInt32BE(20), 360);
      await page.locator('img.tl-image').waitFor();
      await page.locator('.tl-shape[data-shape-type="draw"]').waitFor();
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(
        await attachment.count(),
        1,
        're-edit replaces the same attachment',
      );
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await page.waitForFunction(() => window.sent.length === 1);
      const sent = await page.evaluate(() => window.sent[0]);
      assert.equal(uploaded.length, 2, 're-edited image is uploaded again');
      assert.notEqual(uploaded[0].path, uploaded[1].path);
      assert.equal(
        sent.parts.some((part) => part.type === 'file'),
        false,
        'edited image is sent by workspace reference, not base64',
      );
      assert.ok(
        sent.parts.some(
          (part) =>
            part.type === 'text' && part.text.includes(uploaded[1].path),
        ),
      );

      // Tool-result card and narrow screen use the same editing route.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page
        .getByRole('button', { name: '编辑图片：tool.png', exact: true })
        .click();
      await page.locator('img.tl-image').waitFor();
      const dialog = await page.getByRole('dialog').boundingBox();
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 391);
      const action = await complete.boundingBox();
      const close = await page
        .getByRole('button', { name: '关闭绘画板', exact: true })
        .boundingBox();
      assert.ok(
        Math.abs(action.y - close.y) <= 1 &&
          close.x - (action.x + action.width) <= 10,
        'mobile complete sits beside close',
      );
      const toolbar = await page.locator('.tlui-toolbar').boundingBox();
      assert.ok(
        action && toolbar && action.y + action.height < toolbar.y,
        'complete action must not cover mobile drawing tools',
      );
      await page
        .locator('[data-sonner-toast]')
        .last()
        .waitFor({ state: 'hidden' });
      await page.screenshot({ path: '/tmp/chat-image-edit-mobile.png' });
      await page
        .getByRole('button', { name: '关闭绘画板', exact: true })
        .click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(
        await attachment.count(),
        0,
        'cancel does not attach an image',
      );

      // A source that can be displayed but cannot be fetched is a recoverable error.
      await page.route('**/retry-image.png', (route) =>
        route.fulfill({ status: 503, body: 'unavailable' }),
      );
      await page.evaluate(() => window.setSource('/retry-image.png'));
      await sourceEdit.click();
      await page
        .getByRole('alert')
        .filter({ hasText: '无法加载图片进行编辑' })
        .waitFor();
      assert.ok(await complete.isDisabled());
      const original = await page.evaluate(() => window.original.split(',')[1]);
      await page.unroute('**/retry-image.png');
      await page.route('**/retry-image.png', (route) =>
        route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(original, 'base64'),
        }),
      );
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.locator('img.tl-image').waitFor();
      failNextUpload = true;
      await complete.click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await attachment.waitFor();
      await page.getByRole('button', { name: /^重新上传.*annotated-/ }).click();
      await page.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (button) =>
            button
              .getAttribute('aria-label')
              ?.startsWith('编辑绘图：annotated-'),
        );
        return button && !button.disabled;
      });
      assert.equal(
        uploaded.length,
        3,
        'failed upload retries and keeps its drawing',
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: '/tmp/chat-image-edit-failure.png' });
      console.error('Browser errors:', errors);
      throw error;
    }
  },
);
