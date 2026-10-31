/** Real room-message controls; deterministic transport, no user data or model calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const load = (name) => import(pathToFileURL(webRequire.resolve(name)).href);
const [{ createServer }, { default: react }, { default: tailwindcss }, { default: playwright }] =
  await Promise.all([
    load('vite'),
    load('@vitejs/plugin-react'),
    load('@tailwindcss/vite'),
    import(pathToFileURL(serverRequire.resolve('playwright-core')).href),
  ]);

test('room choices: instant single reply, batched multiple reply, retry identity and mobile', { timeout: 180000 }, async (t) => {
  const fixture = await mkdtemp(path.join(webRoot, '.group-chat-choices-test-'));
  let vite, browser;
  t.after(async () => {
    await browser?.close();
    await vite?.close();
    await rm(fixture, { recursive: true, force: true });
  });
  const entry = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RoomMessage} from '/src/pages/group-chats/components/room-message';
import {initializeI18n, i18n} from '/src/i18n';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {Toaster} from '/src/components/ui/sonner';
import '/src/index.css';
const longLabel='LongOptionWithoutSpaces'.repeat(14);
const questions=[
  {id:'single',text:'下一步先做什么？',choices:{options:['检查需求','开始实现'],multiple:false}},
  {id:'multiple',text:'请选择需要交付的内容',choices:{options:['前端页面','后端接口','验证报告'],multiple:true}},
  {id:'retry',text:'失败后可重试',choices:{options:['重试同一选择','换一个选择'],multiple:false}},
  {id:'long',text:'长选项在窄屏中完整换行',choices:{options:[longLabel,'短选项'],multiple:true}},
];
const base={roomId:'room000000000001',sequence:'1',revision:'1',senderId:'bot000000000001',senderKind:'agent',senderName:'Bot',senderUsername:null,replyToId:null,files:[],ui:null,uiResponse:null,targetAgentId:null,reactions:[],createdAt:'2026-10-31T00:00:00Z'};
window.choiceFixture={calls:[],failNext:false,hold:false,pending:[],longLabel};
function App(){
 const [version,setVersion]=useState(0);
 const [userId,setUserId]=useState('alice');
 const [responses,setResponses]=useState({});
 const send=async(source,id,selectedOptions)=>{
  window.choiceFixture.calls.push({source,id,selectedOptions:[...selectedOptions]});
  if(window.choiceFixture.hold) await new Promise(resolve=>window.choiceFixture.pending.push(resolve));
  if(window.choiceFixture.failNext){window.choiceFixture.failNext=false;throw new Error('Test transport failure');}
  setResponses(previous=>({...previous,[userId+':'+source]:[...selectedOptions]}));
 };
 window.choiceFixture.remount=()=>setVersion(value=>value+1);
 window.choiceFixture.setUser=setUserId;
 window.choiceFixture.setLanguage=(language)=>i18n.changeLanguage(language);
 return <ThemeProvider><main className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4">{questions.map(question=><section key={question.id} data-testid={question.id}><RoomMessage key={version+':'+userId+':'+question.id} message={{...base,...question}} userId={userId} label="Bot" onReply={()=>{}} onJumpToReply={()=>{}} loadingReply={false} onReact={async()=>{}} onRespondUi={async()=>{}} onRespondChoices={(id,selected)=>send(question.id,id,selected)} submittedChoices={responses[userId+':'+question.id]} /></section>)}</main><Toaster/></ThemeProvider>;
}
await initializeI18n();createRoot(document.getElementById('root')).render(<App/>);`;
  await writeFile(path.join(fixture, 'entry.tsx'), entry);
  const entryUrl = '/' + path.relative(webRoot, path.join(fixture, 'entry.tsx'));
  vite = await createServer({
    root: webRoot,
    configFile: false,
    envFile: false,
    cacheDir: path.join(fixture, 'node_modules/.vite'),
    resolve: { alias: { '@': path.join(webRoot, 'src') }, dedupe: ['react', 'react-dom'] },
    optimizeDeps: { exclude: ['@tldraw/assets'] },
    plugins: [react(), tailwindcss(), {
      name: 'room-choices-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (new URL(req.url ?? '/', 'http://fixture').pathname !== '/choices') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml('/', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="root"></div><script type="module" src="' + entryUrl + '"></script></body></html>'));
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => {
    if (!page.isClosed()) await page.screenshot({ path: '/tmp/group-chat-choices-last.png', fullPage: true }).catch(() => {});
  });
  await page.goto('http://127.0.0.1:' + vite.httpServer.address().port + '/choices');
  const calls = () => page.evaluate(() => window.choiceFixture.calls);
  const single = page.getByTestId('single');
  await single.getByRole('button', { name: '检查需求', exact: true }).waitFor();

  // Two synchronous clicks share the same in-flight guard, before React commits disabled state.
  await page.evaluate(() => { window.choiceFixture.hold = true; });
  await single.getByRole('button', { name: '检查需求', exact: true }).evaluate((button) => { button.click(); button.click(); });
  assert.equal((await calls()).length, 1);
  assert.deepEqual((await calls())[0].selectedOptions, ['检查需求']);
  assert.equal(await single.getByRole('button', { name: '开始实现', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.choiceFixture.hold = false; window.choiceFixture.pending.splice(0).forEach(resolve => resolve()); });
  await single.getByText('选择已发送给 Bot', { exact: true }).waitFor();

  const multiple = page.getByTestId('multiple');
  assert.equal(await multiple.getByRole('button', { name: '发送选择', exact: true }).isDisabled(), true);
  await multiple.getByRole('checkbox', { name: '前端页面', exact: true }).check();
  await multiple.getByRole('checkbox', { name: '验证报告', exact: true }).check();
  assert.equal((await calls()).length, 1, 'checking multiple choices must not send partial answers');
  await multiple.getByRole('button', { name: '发送选择', exact: true }).click();
  await multiple.getByText('选择已发送给 Bot', { exact: true }).waitFor();
  assert.deepEqual((await calls())[1].selectedOptions, ['前端页面', '验证报告']);

  const retry = page.getByTestId('retry');
  await page.evaluate(() => { window.choiceFixture.failNext = true; });
  await retry.getByRole('button', { name: '重试同一选择', exact: true }).click();
  await page.waitForFunction(() => window.choiceFixture.calls.length === 3);
  await retry.getByRole('button', { name: '重试同一选择', exact: true }).click();
  await retry.getByText('选择已发送给 Bot', { exact: true }).waitFor();
  const retryCalls = (await calls()).filter(call => call.source === 'retry');
  assert.equal(retryCalls.length, 2);
  assert.equal(retryCalls[0].id, retryCalls[1].id, 'network retry must preserve the message id');
  assert.deepEqual(retryCalls[0].selectedOptions, retryCalls[1].selectedOptions);

  await page.evaluate(() => window.choiceFixture.remount());
  await single.getByText('选择已发送给 Bot', { exact: true }).waitFor();
  assert.equal(await single.getByRole('button', { name: '开始实现', exact: true }).isDisabled(), true);
  await page.screenshot({ path: '/tmp/group-chat-choices-desktop.png', fullPage: true });

  // A different room member remains free to answer the same question independently.
  await page.evaluate(() => window.choiceFixture.setUser('bob'));
  await single.getByRole('button', { name: '开始实现', exact: true }).click();
  await single.getByText('选择已发送给 Bot', { exact: true }).waitFor();
  assert.deepEqual((await calls()).at(-1).selectedOptions, ['开始实现']);

  await page.setViewportSize({ width: 375, height: 812 });
  const long = page.getByTestId('long');
  await long.getByRole('checkbox', { name: '短选项', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await long.getByRole('checkbox', { name: '短选项', exact: true }).isChecked(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'long option labels must wrap on mobile');
  await page.screenshot({ path: '/tmp/group-chat-choices-mobile.png', fullPage: true });
  await page.evaluate(() => window.choiceFixture.setLanguage('en'));
  await long.getByRole('button', { name: 'Send selection', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
