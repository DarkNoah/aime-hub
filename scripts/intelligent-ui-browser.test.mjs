/** Real Chromium checks against the production renderer; no API credentials or model calls. */
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

const style =
  '<style>h2{margin:0 0 8px;font-size:20px}p{color:var(--muted-foreground)}label{display:block;margin:16px 0 6px}input:not([type=checkbox]),select{width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;background:var(--background);color:var(--foreground)}button{margin-top:16px;padding:9px 16px;border:0;border-radius:6px;background:var(--primary);color:var(--primary-foreground);transition:transform .18s,opacity .18s}button:active{transform:scale(.98)}.checks{display:flex;gap:12px}.checks label{margin:10px 0}#cells{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}#cells button{background:var(--muted);color:var(--foreground)}#cells button:hover{background:var(--primary);color:var(--primary-foreground)}</style>';
const panels = [
  {
    id: 'form',
    title: '偏好设置',
    waitForResponse: true,
    tips: '填写名称，选择关注方向并调整数值。',
    html:
      style +
      '<h2>设置你的报告</h2><form data-ui-resume=\'{"action":"save"}\'><label for="name">名称</label><input id="name" name="name" required><label for="level">关注度</label><input id="level" name="level" type="range" min="0" max="100" value="35"><div class="checks"><label><input name="topics" type="checkbox" value="design"> 设计</label><label><input name="topics" type="checkbox" value="data"> 数据</label></div><button type="submit" name="intent" value="save">保存设置</button></form>',
  },
  {
    id: 'heatmap',
    title: '交互热力图',
    waitForResponse: true,
    html:
      style +
      '<h2>选择区域</h2><p>点击单元格，将位置传回 runtime。</p><div id="cells">' +
      Array.from(
        { length: 8 },
        (_, i) =>
          '<button aria-label="cell-' +
          i +
          '" onclick="window.IntelligentUI.resume({action:\'cell\',index:' +
          i +
          ',point:{x:event.offsetX,y:event.offsetY}})">' +
          (i + 1) +
          '</button>',
      ).join('') +
      '</div>',
  },
  {
    id: 'display',
    title: '天气展示',
    tips: null,
    html:
      style +
      '<h2>晴 · 24°C</h2><p>静态示例数据，图表交互不会阻塞对话。</p><button id="toggle" onclick="document.querySelector(\'#forecast\').textContent=\'明天 26°C\'">查看明天</button><p id="forecast">今天 24°C</p>',
  },
  {
    id: 'null-optionals',
    title: null,
    tips: null,
    waitForResponse: null,
    html: '<h2>可选字段为空的展示卡片</h2><button onclick="this.textContent=\'已点击\'">本地交互</button>',
  },
  {
    id: 'links',
    title: '带图片和链接的结果卡片',
    html: `<style>.result{display:flex;gap:16px;align-items:center}.result img{width:96px;height:64px;object-fit:cover;border-radius:8px}.result svg{width:18px;height:18px;vertical-align:middle}a{color:var(--primary)}</style>
      <article class="result"><img src="https://example.test/thumbnail.svg" alt="结果缩略图"><div><h2>示例结果</h2><a id="details" href="https://example.test/details" target="_top" ping="https://example.test/ping" download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>查看详情</span></a></div></article>
      <a id="http-link" href="http://example.test/source">查看来源</a>
      <a id="script-link" href="javascript:alert('unexpected')">无效脚本链接</a>
      <a id="data-link" href="data:text/html,unexpected">无效数据链接</a>
      <a id="relative-link" href="/private">无效相对链接</a>
      <script>document.querySelector('#details').click();parent.postMessage({channel: 'intelligent-ui', token: document.querySelector('script[data-token]').dataset.token, type: 'open-link', url: 'https://example.test/automatic'}, '*');</script>`,
  },
  {
    id: 'slider',
    title: '滑动完成操作',
    waitForResponse: true,
    html:
      style +
      '<label for="slider">调整到所需位置</label><input id="slider" type="range" min="0" max="100" value="20" onchange="window.IntelligentUI.resume({action:\'slide\',value:Number(this.value)})">',
  },
];

test(
  'HTML panels: forms, retry, events, links, images, auto height, sandbox, theme and turn order',
  { timeout: 120000 },
  async (t) => {
    const fixture = await mkdtemp(path.join(webRoot, '.intelligent-ui-test-'));
    const imageRequests = [];
    let vite;
    let browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {IntelligentUI} from '/src/components/chat/tool-renderers/intelligent-ui';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {useTheme} from '/src/components/theme/context';
import {initializeI18n} from '/src/i18n';
import '/src/index.css';
const panels=${JSON.stringify(panels)};
panels.find(panel=>panel.id==='links').html=panels.find(panel=>panel.id==='links').html.replace('https://example.test/thumbnail.svg',location.origin+'/thumbnail.svg');
const ChatTurns=React.lazy(()=>import('/src/components/chat/chat-turns').then(module=>({default:module.ChatTurns})));
const orderedPanel={type:'tool-IntelligentUI',toolCallId:'ordered',state:'output-available',input:{title:'顺序检查',tips:null,waitForResponse:false,html:'<p>这是图表内容</p>'},output:{rendered:true}};
const finalText={type:'text',text:'这是图表后的最终说明',state:'done'};
const orderedUser={id:'order-turn',role:'user',parts:[{type:'text',text:'展示图表并说明'}]};
const orderedSummary={id:'order-turn',user:orderedUser,assistant:{id:'order-assistant',role:'assistant',parts:[orderedPanel,finalText]},hasDetails:true,toolCount:1,revision:'order-revision',assetRevision:''};
const orderedDetail={id:'order-turn',revision:'order-revision',messages:[orderedUser,{id:'order-assistant',role:'assistant',parts:[{type:'text',text:'正在准备图表'},orderedPanel,finalText]}]};
function TurnOrder(){const [details,setDetails]=React.useState(new Map());return <ChatTurns turns={[orderedSummary]} details={details} loadDetails={async()=>{setDetails(new Map([['order-turn',orderedDetail]]));return orderedDetail;}} threadId="test-thread" running={false} activeTurnId={null} activeMessageId={null} toolInteractions={[]} onToolResponse={async()=>{}} disabled={false}/>;}
window.records=[]; window.failFirst=true;
function App(){const {setTheme}=useTheme(); return <main style={{maxWidth:760,margin:'24px auto',padding:16}}><button id="theme" onClick={()=>setTheme('dark')}>深色主题</button>{panels.map(({id,...input})=><div key={id} data-panel={id}><IntelligentUI tool={{type:'tool-IntelligentUI',toolCallId:id,input,state:input.waitForResponse?'input-available':'output-available',...(input.waitForResponse?{}:{output:{rendered:true}})}} interaction={input.waitForResponse?{id,toolCallId:id,toolName:'IntelligentUI',kind:'suspended',runId:'run',input}:undefined} onRespond={async (interactionId,response)=>{window.records.push({interactionId,...response}); await new Promise(r=>setTimeout(r,80)); if(interactionId==='form'&&window.failFirst){window.failFirst=false;throw new Error('Connection lost');}}}/></div>)}</main>}
await initializeI18n();createRoot(document.getElementById('root')).render(<ThemeProvider>{location.search==='?turn'?<main style={{maxWidth:760,margin:'24px auto',padding:16}}><React.Suspense fallback="加载中"><TurnOrder/></React.Suspense></main>:<App/>}</ThemeProvider>);`;
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
          name: 'ui-test',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
              if (req.url === '/thumbnail.svg') {
                imageRequests.push(req.headers);
                res.setHeader('Content-Type', 'image/svg+xml');
                res.end(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="#16805c"/><circle cx="48" cy="32" r="18" fill="white"/></svg>',
                );
                return;
              }
              if (req.url?.split('?')[0] !== '/') return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await server.transformIndexHtml(
                  '/',
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="' +
                    entryUrl +
                    '"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 5189 },
    });
    await vite.listen();
    const port = vite.httpServer.address().port;
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const page = await browser.newPage({
      viewport: { width: 1100, height: 1000 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    });
    await page.context().route(/^https?:\/\/example\.test\//, async (route) => {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Destination</title><p>Link destination</p>',
      });
    });
    const errors = [];
    const browserMessages = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => browserMessages.push(message.text()));
    page.on('requestfailed', (request) =>
      browserMessages.push(request.url() + ': ' + request.failure()?.errorText),
    );
    await page.goto('http://127.0.0.1:' + port);
    await page.locator('[data-panel=form] iframe').waitFor();
    const frames = {};
    for (const id of panels.map((p) => p.id)) {
      assert.equal(
        await page.locator('[data-panel=' + id + '] iframe').count(),
        1,
        id + ' renders HTML even when optional fields are null',
      );
      frames[id] = await (
        await page.locator('[data-panel=' + id + '] iframe').elementHandle()
      ).contentFrame();
      await frames[id].waitForFunction(
        () => document.body && !document.body.inert,
      );
    }
    await t.test(
      'images render and web links open only on user activation',
      async () => {
        const links = frames.links;
        await links.waitForFunction(() => {
          const image = document.querySelector('img');
          return image.complete;
        });
        assert.equal(
          await links.locator('img').evaluate((image) => image.naturalWidth),
          96,
          browserMessages.join('\n'),
        );
        assert.equal(imageRequests.length, 1);
        assert.equal(imageRequests[0].referer, undefined);
        assert.equal(await links.locator('svg path').count(), 1);
        assert.equal(page.context().pages().length, 1, 'no automatic tabs');
        for (const id of ['script-link', 'data-link', 'relative-link'])
          assert.equal(
            await links.locator('#' + id).getAttribute('href'),
            null,
          );
        assert.equal(
          await links.locator('#details').getAttribute('ping'),
          null,
        );
        assert.equal(
          await links.locator('#details').getAttribute('download'),
          null,
        );

        const open = async (activate, expectedUrl) => {
          const popupReady = page.waitForEvent('popup');
          await activate();
          const popup = await popupReady;
          await popup.waitForLoadState();
          assert.equal(popup.url(), expectedUrl);
          assert.deepEqual(
            await popup.evaluate(() => ({
              opener: window.opener,
              referrer: document.referrer,
            })),
            { opener: null, referrer: '' },
          );
          await popup.close();
        };
        await open(
          () => links.locator('#details span').click(),
          'https://example.test/details',
        );
        await open(
          () => links.locator('#http-link').press('Enter'),
          'http://example.test/source',
        );
        await open(
          () => links.locator('#details').click({ button: 'middle' }),
          'https://example.test/details',
        );
        await links.locator('#details').dispatchEvent('click');
        await links.evaluate(() => {
          const link = document.createElement('a');
          link.id = 'dynamic-link';
          link.href = 'javascript:alert("unexpected")';
          link.textContent = 'Invalid dynamic link';
          document.body.append(link);
        });
        await links.locator('#dynamic-link').click();
        await page.evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 100)),
        );
        assert.equal(
          page.context().pages().length,
          1,
          'reject synthetic clicks and invalid dynamic URLs',
        );
        assert.equal(
          await page.evaluate(() => window.records.length),
          0,
          'links do not submit the panel',
        );
        assert.equal(page.url(), 'http://127.0.0.1:' + port + '/');
        assert.equal(links.url(), 'about:srcdoc');
        await page
          .locator('[data-panel=links]')
          .screenshot({ path: '/tmp/intelligent-ui-links.png' });
      },
    );
    const nullOptionals = frames['null-optionals'];
    assert.equal(
      await page
        .locator('[data-panel=null-optionals] iframe')
        .getAttribute('title'),
      'IntelligentUI',
    );
    await nullOptionals
      .getByRole('button', { name: '本地交互' })
      .press('Enter');
    await nullOptionals.getByRole('button', { name: '已点击' }).waitFor();
    assert.equal(await nullOptionals.getByRole('button').innerText(), '已点击');
    const form = frames.form;
    const token = (
      await page.locator('[data-panel=form] iframe').getAttribute('srcdoc')
    ).match(/data-token="([^"]+)"/)[1];
    await page.evaluate(
      (token) =>
        window.postMessage(
          {
            channel: 'intelligent-ui',
            token,
            type: 'resume',
            data: { forged: true },
          },
          '*',
        ),
      token,
    );
    await form.evaluate(() =>
      parent.postMessage(
        {
          channel: 'intelligent-ui',
          token: 'wrong',
          type: 'resume',
          data: { forged: true },
        },
        '*',
      ),
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page.evaluate(() => window.records.length),
      0,
      'reject wrong frame and token',
    );
    await form.getByRole('button', { name: '保存设置' }).click();
    assert.equal(
      await page.evaluate(() => window.records.length),
      0,
      'required field validation must run',
    );
    await form.locator('#name').fill('Noah');
    await form.locator('[value=design]').check();
    await form.locator('[value=data]').check();
    await form.locator('#level').fill('70');
    await form.getByRole('button', { name: '保存设置' }).click();
    await page.locator('[data-panel=form] [role=alert]').waitFor();
    assert.equal(
      await form.locator('#name').inputValue(),
      'Noah',
      'failure preserves form',
    );
    await form.waitForFunction(() => !document.body.inert);
    await form.getByRole('button', { name: '保存设置' }).click();
    await page.locator('[data-panel=form] summary').waitFor();
    const submitted = await page.evaluate(() =>
      window.records.filter((r) => r.interactionId === 'form'),
    );
    assert.equal(submitted.length, 2);
    assert.equal(
      submitted[0].id,
      submitted[1].id,
      'retry uses the original acknowledgement ID',
    );
    assert.deepEqual(submitted[1].data, {
      name: 'Noah',
      level: '70',
      topics: ['design', 'data'],
      intent: 'save',
      action: 'save',
    });
    await form.evaluate(() => {
      window.IntelligentUI.resume({ duplicate: true });
    });
    assert.equal(await page.evaluate(() => window.records.length), 2);
    await frames.heatmap
      .getByRole('button', { name: 'cell-3', exact: true })
      .click();
    await page.waitForFunction(() =>
      window.records.some((r) => r.interactionId === 'heatmap'),
    );
    await page.locator('[data-panel=heatmap] summary').waitFor();
    const point = await page.evaluate(
      () => window.records.find((r) => r.interactionId === 'heatmap').data,
    );
    assert.equal(point.index, 3);
    assert.equal(typeof point.point.x, 'number');
    await frames.slider.locator('#slider').fill('88');
    await frames.slider.locator('#slider').dispatchEvent('change');
    await page.waitForFunction(() =>
      window.records.some((r) => r.interactionId === 'slider'),
    );
    await page.locator('[data-panel=slider] summary').waitFor();
    assert.deepEqual(
      await page.evaluate(
        () => window.records.find((r) => r.interactionId === 'slider').data,
      ),
      { action: 'slide', value: 88 },
    );
    await frames.display.locator('#toggle').click();
    assert.equal(
      await frames.display.locator('#forecast').innerText(),
      '明天 26°C',
    );
    const displayHeight = await frames.display.evaluate(() =>
      Math.ceil(document.body.getBoundingClientRect().height),
    );
    for (const extraHeight of [1200, 4500, 0]) {
      const expectedHeight = await frames.display.evaluate((height) => {
        document.getElementById('height-test')?.remove();
        if (height) {
          const content = document.createElement('div');
          content.id = 'height-test';
          content.style.height = height + 'px';
          document.body.append(content);
        }
        return Math.ceil(document.body.getBoundingClientRect().height);
      }, extraHeight);
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-panel=display] iframe').clientHeight ===
          expected,
        expectedHeight,
      );
      assert.equal(
        await frames.display.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
        ),
        true,
        'the iframe expands to its content without internal scrolling',
      );
      assert.equal(
        await page.locator('[data-panel=display]').evaluate((panel) => {
          const frame = panel.querySelector('iframe');
          return panel.getBoundingClientRect().height >= frame.clientHeight;
        }),
        true,
        'the panel expands with its iframe beyond the former height caps',
      );
      if (!extraHeight)
        assert.equal(expectedHeight, displayHeight, 'height shrinks again');
    }
    await frames.display.evaluate(() =>
      window.IntelligentUI.resume({ unwanted: true }),
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.records.filter((r) => r.interactionId === 'display').length,
      ),
      0,
    );
    assert.equal(
      await frames.display.evaluate(() => {
        try {
          return !!parent.document;
        } catch {
          return false;
        }
      }),
      false,
    );
    assert.equal(
      await frames.display.evaluate(async () => {
        try {
          await fetch('/api/private');
          return true;
        } catch {
          return false;
        }
      }),
      false,
    );
    assert.equal(
      await page.locator('[data-panel=display] iframe').getAttribute('sandbox'),
      'allow-scripts allow-forms',
    );
    await page.locator('#theme').click();
    await frames.display.waitForFunction(
      () => document.documentElement.style.colorScheme === 'dark',
    );
    assert.equal(
      await frames.display.locator('#forecast').innerText(),
      '明天 26°C',
      'theme change keeps local state',
    );
    for (const width of [390, 768, 1100]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    await page.setViewportSize({ width: 1100, height: 1600 });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      return new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({ path: '/tmp/intelligent-ui-desktop.png' });
    await page.setViewportSize({ width: 390, height: 1600 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.screenshot({ path: '/tmp/intelligent-ui-mobile.png' });
    await page.goto('http://127.0.0.1:' + port + '/?turn');
    const assertTurnOrder = async () => {
      await page.getByText('这是图表后的最终说明', { exact: true }).waitFor();
      assert.equal(await page.locator('iframe[title="顺序检查"]').count(), 1);
      assert.equal(
        await page.evaluate(() => {
          const panel = document.querySelector(
            'section[aria-label="顺序检查"]',
          );
          const text = [...document.querySelectorAll('p')].find(
            (node) => node.textContent === '这是图表后的最终说明',
          );
          return !!(
            panel.compareDocumentPosition(text) &
            Node.DOCUMENT_POSITION_FOLLOWING
          );
        }),
        true,
        'panel remains before the final text and is rendered exactly once',
      );
    };
    await assertTurnOrder();
    assert.equal(
      await page.getByText('正在准备图表', { exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: '查看详情', exact: true }).click();
    await page.locator('[data-chat-turn-detail="order-turn"]').waitFor();
    await page.getByText('正在准备图表', { exact: true }).waitFor();
    await assertTurnOrder();
    await page.getByRole('button', { name: '收起详情', exact: true }).click();
    await assertTurnOrder();
    assert.deepEqual(errors, []);
  },
);
