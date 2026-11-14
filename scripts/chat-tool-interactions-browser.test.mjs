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
window.records=[];window.groupReads=[];
const askInput={question:'请选择回测口径',options:[{label:'日线点数回测'},{label:'1分钟点数回测'}],selectionMode:'single_select'};
const askPart={...(location.search.includes('dynamic')?{type:'dynamic-tool',toolName:'ask_user'}:{type:'tool-ask_user'}),toolCallId:'pending-ask',state:'input-available',input:askInput,forceRender:true};
const askUser={id:'ask-turn',role:'user',parts:[{type:'text',text:'创建并回测策略'}]};
const askText={type:'text',text:'请确认回测口径。',state:'done'};
const finalText={type:'text',text:'已按所选口径继续。',state:'done'};
const reasoning={type:'reasoning',text:'核对回测参数。',state:'done'};
const readPart={type:'tool-read_file',toolCallId:'read-parameters',state:'output-available',input:{path:'parameters.txt'},output:'period=day'};
const askGroup={id:'ask-tools',count:1,revision:'ask-tools-v1',state:'completed'};
const previousGroup={...askGroup,id:'previous-tools',revision:'previous-tools-v1'};
const groupPart=group=>({type:'data-tool-group',data:group});
const askAssistant={id:'ask-assistant',role:'assistant',parts:[groupPart(askGroup),askText,askPart]};
const askSummary={id:'ask-turn',user:askUser,assistant:askAssistant,hasDetails:true,toolCount:2,revision:'pending',assetRevision:''};
const previousAsk={...askPart,toolCallId:'previous-ask',state:'output-available',output:'此前答案'};
const previousSummary={...askSummary,id:'previous-turn',user:{...askUser,id:'previous-turn'},assistant:{id:'previous-assistant',role:'assistant',parts:[groupPart(previousGroup),previousAsk]},revision:'previous'};
function AskTurn(){
  const [answer,setAnswer]=React.useState(null);
  const [groupDetails,setGroupDetails]=React.useState(new Map());
  const [interactions,setInteractions]=React.useState([{id:'pending-interaction',toolCallId:'pending-ask',toolName:'ask_user',kind:'suspended',runId:'ask-run',input:askInput,suspendPayload:askInput}]);
  const completedAsk={...askPart,state:'output-available',output:answer};
  const summary=answer===null?askSummary:{...askSummary,revision:'answered',assistant:{...askAssistant,parts:[groupPart(askGroup),askText,completedAsk,finalText]}};
  return <ChatTurns turns={[previousSummary,summary]} groupDetails={groupDetails} loadGroupDetails={async(turn,group,page=0)=>{
    window.groupReads.push({turnId:turn.id,groupId:group.id,page});
    const detail={id:group.id,revision:group.revision,messages:[{id:turn.id+'-tools',role:'assistant',parts:[reasoning,{...readPart,toolCallId:group.id+'-read'}]}],page:0,hasMore:false};
    setGroupDetails(current=>new Map(current).set(turn.id+':'+group.id,{...detail,summaryRevision:group.revision}));
    return detail;
  }} threadId="ask-test" running={false} activeTurnId={null} activeMessageId={null} toolInteractions={interactions} onToolResponse={async(interactionId,response)=>{
    window.records.push({interactionId,...response});
    setInteractions(current=>current.map(item=>({...item,response})));
    setAnswer(response.data);
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
        `pending ask renders once with expanded tool groups (${query})`,
        async () => {
          await page.goto('http://127.0.0.1:' + port + '/' + query);
          const question = page.getByRole('group', {
            name: '请选择回测口径',
            exact: true,
          });
          const currentTurn = page.locator('[data-chat-turn="ask-turn"]');
          const previousTurn = page.locator('[data-chat-turn="previous-turn"]');
          const currentGroup = currentTurn.locator(
            '[data-chat-tool-group="ask-tools"]',
          );
          const previousGroup = previousTurn.locator(
            '[data-chat-tool-group="previous-tools"]',
          );
          const currentDetail = currentGroup.locator(
            '[data-chat-tool-group-detail="ask-tools"]',
          );
          await question.getByRole('textbox').waitFor();
          await previousTurn.getByText('此前答案', { exact: true }).waitFor();
          assert.equal(await question.count(), 2);
          assert.deepEqual(
            await page.evaluate(() => window.groupReads),
            [],
            'closed groups do not fetch details',
          );
          await question.getByRole('textbox').fill('浏览器回归答案');
          await currentGroup.locator('button[aria-expanded]').first().click();
          await currentDetail.waitFor();
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
          await currentGroup.locator('button[aria-expanded]').first().click();
          await currentDetail.waitFor({ state: 'hidden' });
          assert.equal(await question.count(), 2);
          assert.equal(
            await question.getByRole('textbox').inputValue(),
            '浏览器回归答案',
          );
          await currentGroup.locator('button[aria-expanded]').first().click();
          await currentDetail.waitFor();
          await previousGroup.locator('button[aria-expanded]').first().click();
          await previousGroup
            .locator('[data-chat-tool-group-detail]')
            .waitFor();
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
            'each answered call appears only once alongside its tool group',
          );
          assert.equal(await question.getByRole('textbox').count(), 0);
          await currentGroup.locator('button[aria-expanded]').first().click();
          await currentDetail.waitFor({ state: 'hidden' });
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
          assert.equal(await currentDetail.count(), 0);
          await currentGroup.locator('button[aria-expanded]').first().click();
          await currentDetail.waitFor();
          assert.equal(
            await question.count(),
            2,
            'expanding answered tool groups must not duplicate the overview',
          );
          assert.deepEqual(
            await page.evaluate(() => window.groupReads),
            [
              { turnId: 'ask-turn', groupId: 'ask-tools', page: 0 },
              { turnId: 'previous-turn', groupId: 'previous-tools', page: 0 },
            ],
            'reopening groups and answering a question reuse unchanged details',
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
