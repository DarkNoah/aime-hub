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

test(
  'pending tool interactions stay actionable without duplicate turn details',
  { timeout: 60000 },
  async (t) => {
    const fixture = await mkdtemp(
      path.join(webRoot, '.chat-interactions-test-'),
    );
    let vite;
    let browser;
    t.after(async () => {
      await browser?.close();
      await vite?.close();
      await rm(fixture, { recursive: true, force: true });
    });
    const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTurns} from '/src/components/chat/chat-turns';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {initializeI18n} from '/src/i18n';
import '/src/index.css';
window.records=[];
const askInput={question:'请选择回测口径',options:[{label:'日线点数回测'},{label:'1分钟点数回测'}],selectionMode:'single_select'};
const askPart={...(location.search.includes('dynamic')?{type:'dynamic-tool',toolName:'ask_user'}:{type:'tool-ask_user'}),toolCallId:'pending-ask',state:'input-available',input:askInput};
const askUser={id:'ask-turn',role:'user',parts:[{type:'text',text:'创建并回测策略'}]};
const askText={type:'text',text:'请确认回测口径。'};
const finalText={type:'text',text:'已按所选口径继续。'};
const reasoning={type:'reasoning',text:'核对回测参数。',state:'done'};
const askAssistant={id:'ask-assistant',role:'assistant',parts:[reasoning,askText,askPart]};
const askSummary={id:'ask-turn',user:askUser,assistant:{...askAssistant,parts:[askText]},hasDetails:true,toolCount:1,revision:'pending',assetRevision:''};
const askDetail={id:'ask-turn',revision:'pending',messages:[askUser,askAssistant]};
const previousAsk={...askPart,toolCallId:'previous-ask',state:'output-available',output:'此前答案'};
const previousSummary={...askSummary,id:'previous-turn',user:{...askUser,id:'previous-turn'},assistant:{id:'previous-assistant',role:'assistant',parts:[previousAsk]},revision:'previous'};
const previousDetail={id:'previous-turn',revision:'previous',messages:[{id:'previous-assistant',role:'assistant',parts:[reasoning,previousAsk]}]};
function AskTurn(){
  const [answer,setAnswer]=React.useState(null);
  const [details,setDetails]=React.useState(new Map());
  const [interactions,setInteractions]=React.useState([{id:'pending-interaction',toolCallId:'pending-ask',toolName:'ask_user',kind:'suspended',runId:'ask-run',input:askInput,suspendPayload:askInput}]);
  const completedAsk={...askPart,state:'output-available',output:answer};
  const completedDetail={...askDetail,revision:'answered',messages:[askUser,{...askAssistant,parts:[reasoning,askText,completedAsk,finalText]}]};
  const summary=answer===null?askSummary:{...askSummary,revision:'answered',assistant:{...askAssistant,parts:[completedAsk,finalText]}};
  return <ChatTurns turns={[previousSummary,summary]} details={details} loadDetails={async(turn)=>{const detail=turn.id==='previous-turn'?previousDetail:answer===null?askDetail:completedDetail;setDetails(current=>new Map(current).set(turn.id,detail));return detail;}} threadId="ask-test" running={false} activeTurnId={null} activeMessageId={null} toolInteractions={interactions} onToolResponse={async(interactionId,response)=>{
    window.records.push({interactionId,...response});
    setInteractions(current=>current.map(item=>({...item,response})));
    setAnswer(response.data);
    setDetails(current=>new Map(current).set('ask-turn',{...completedDetail,messages:[askUser,{...askAssistant,parts:[reasoning,askText,{...completedAsk,output:response.data},finalText]}]}));
  }} disabled={false}/>;
}

await initializeI18n();
createRoot(document.getElementById('root')).render(<ThemeProvider><AskTurn/></ThemeProvider>);`;
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
          name: 'chat-interaction-test',
          configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
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
      server: { host: '127.0.0.1', port: 0 },
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
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const query of ['?ask', '?ask-dynamic']) {
      await t.test(
        `pending ask renders once with expanded details (${query})`,
        async () => {
          await page.goto('http://127.0.0.1:' + port + '/' + query);
          const question = page.getByRole('group', {
            name: '请选择回测口径',
            exact: true,
          });
          const currentTurn = page.locator('[data-chat-turn="ask-turn"]');
          const previousTurn = page.locator('[data-chat-turn="previous-turn"]');
          await question.getByRole('textbox').waitFor();
          await previousTurn.getByText('此前答案', { exact: true }).waitFor();
          assert.equal(await question.count(), 2);
          await question.getByRole('textbox').fill('浏览器回归答案');
          await currentTurn
            .getByRole('button', { name: '查看详情', exact: true })
            .click();
          await currentTurn.locator('[data-chat-turn-detail]').waitFor();
          assert.equal(
            await question.count(),
            2,
            'the actionable ask must not repeat in details',
          );
          assert.equal(
            await question.getByRole('textbox').inputValue(),
            '浏览器回归答案',
          );
          assert.equal(await question.getByRole('textbox').isEnabled(), true);
          await currentTurn
            .getByRole('button', { name: '收起详情', exact: true })
            .click();
          assert.equal(await question.count(), 2);
          assert.equal(
            await question.getByRole('textbox').inputValue(),
            '浏览器回归答案',
          );
          await currentTurn
            .getByRole('button', { name: '查看详情', exact: true })
            .click();
          await currentTurn.locator('[data-chat-turn-detail]').waitFor();
          await previousTurn
            .getByRole('button', { name: '查看详情', exact: true })
            .click();
          await previousTurn.getByText('此前答案', { exact: true }).waitFor();
          assert.equal(
            await question.count(),
            2,
            'an older answered call with the same question stays visible',
          );
          assert.equal(await question.getByRole('textbox').count(), 1);
          await question.locator('button[type="submit"]').click();
          await currentTurn
            .getByText('浏览器回归答案', { exact: true })
            .waitFor();
          assert.equal(
            await question.count(),
            2,
            'each answered call appears only once in its details',
          );
          assert.equal(await question.getByRole('textbox').count(), 0);
          await currentTurn
            .getByRole('button', { name: '收起详情', exact: true })
            .click();
          await currentTurn
            .getByText('浏览器回归答案', { exact: true })
            .waitFor();
          await currentTurn
            .getByText('已按所选口径继续。', { exact: true })
            .waitFor();
          assert.equal(
            await question.count(),
            2,
            'answered questions remain visible when collapsed',
          );
          assert.equal(
            await currentTurn.locator('[data-chat-turn-detail]').count(),
            0,
          );
          await currentTurn
            .getByRole('button', { name: '查看详情', exact: true })
            .click();
          await currentTurn.locator('[data-chat-turn-detail]').waitFor();
          assert.equal(
            await question.count(),
            2,
            'expanding answered turns must not duplicate the overview',
          );
          assert.deepEqual(
            await page.evaluate(() =>
              window.records.map(({ interactionId, action, data }) => ({
                interactionId,
                action,
                data,
              })),
            ),
            [
              {
                interactionId: 'pending-interaction',
                action: 'resume',
                data: '浏览器回归答案',
              },
            ],
          );
        },
      );
    }

    assert.deepEqual(errors, []);
  },
);
