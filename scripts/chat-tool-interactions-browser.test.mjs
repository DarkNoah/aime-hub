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
import {ChatThreadView} from '/src/components/chat/chat-thread-view';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {initializeI18n} from '/src/i18n';
import '/src/index.css';
window.records=[];window.batchRecords=[];window.groupReads=[];
const askInput={question:'请选择回测口径',options:[{label:'日线点数回测'},{label:'1分钟点数回测'}],selectionMode:'single_select'};
const askPart={...(location.search.includes('dynamic')?{type:'dynamic-tool',toolName:'ask_user'}:{type:'tool-ask_user'}),toolCallId:'pending-ask',state:'input-available',input:askInput,forceRender:true};
const askUser={id:'ask-turn',role:'user',parts:[{type:'text',text:'创建并回测策略'}]};
const askText={type:'text',text:'请确认回测口径。',state:'done'};
const finalText={type:'text',text:'已按所选口径继续。',state:'done'};
const reasoning={type:'reasoning',text:'核对回测参数。',state:'done'};
const readPart={type:'tool-read_file',toolCallId:'read-parameters',state:'output-available',input:{path:'parameters.txt'},output:'period=day'};
const askGroup={id:'ask-tools',count:1,statusCounts:{success:1,failed:0,running:0},revision:'ask-tools-v1',state:'completed'};
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

const pairedInputs={
  first:{question:'选择回测周期',selectionMode:'single_select',options:[{label:'按周'}]},
  second:{question:'填写交易品种',selectionMode:'multi_select',options:[{label:'螺纹钢'},{label:'镍'}]},
};
const pairedIds=Object.keys(pairedInputs);
function PairedAskTurn(){
  const [snapshot,publish]=React.useState({pending:[],running:true});
  window.publishAsk=publish;
  const parts=(snapshot.visible??pairedIds).map(id=>{
    const output=snapshot.results?.[id];
    const errorText=snapshot.errors?.[id];
    // Live providers can write null option descriptions into raw message parts.
    // The native suspension below has already omitted them.
    const question=pairedInputs[id];
    const input={...question,options:question.options.map(option=>({...option,description:null}))};
    return {type:'tool-ask_user',toolCallId:id,forceRender:true,input,
      ...(errorText?{state:'output-error',errorText}:output===undefined?{state:'input-available'}:output===null
        ?{state:'output-denied',approval:{id,approved:false}}:{state:'output-available',output})};
  });
  const interactions=snapshot.pending.map(id=>({id:'interaction-'+id,toolCallId:id,turnId:'ask-turn',toolName:'ask_user',kind:'suspended',runId:'parallel',input:pairedInputs[id],suspendPayload:pairedInputs[id]}));
  const oldTurn={...previousSummary,assistant:{...previousSummary.assistant,parts:[{...previousAsk,toolCallId:'first',input:{question:'以前的问题'}}]}};
  const currentTurn={...askSummary,askUserGroups:snapshot.groups??[pairedIds],assistant:{...askAssistant,parts:[askText,...parts]}};
  const turns=[oldTurn,currentTurn];
  if (snapshot.laterTurn) turns.push({...askSummary,id:'later-turn',assistant:null});
  const chat={turns,connected:true,thread:{status:snapshot.status??(snapshot.running?'running':interactions.length?'suspended':'success')},
    activeTurnId:'ask-turn',activeMessageId:'ask-assistant',toolInteractions:interactions,
    respondToTool:async(id,value)=>{window.records.push({id,action:value.action,data:value.data});},
    respondToQuestions:async(interactionId,answers)=>{window.batchRecords.push({interactionId,answers});}};
  return <div data-thread-status={chat.thread.status}><ChatThreadView threadId="paired" chat={chat} readOnly={location.search.includes('readonly')}/></div>;
}

await initializeI18n();
createRoot(document.getElementById('root')).render(<ThemeProvider>{location.search.includes('paired')?<PairedAskTurn/>:<AskTurn/>}</ThemeProvider>);`;
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
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    const errors = [];
    const origin = 'http://127.0.0.1:' + port;
    const turn = page.locator('[data-chat-turn="ask-turn"]');
    const form = turn.getByRole('group', {
      name: '问题与回答',
      exact: true,
    });
    const firstQuestion = form.getByRole('group', {
      name: '选择回测周期',
      exact: true,
    });
    const secondQuestion = form.getByRole('group', {
      name: '填写交易品种',
      exact: true,
    });
    const submit = form.getByRole('button', { name: '提交回答', exact: true });
    async function assertStacked() {
      const [first, second] = await Promise.all([
        firstQuestion.boundingBox(),
        secondQuestion.boundingBox(),
      ]);
      assert.ok(first && second, 'both questions are rendered together');
      assert.ok(
        second.y >= first.y + first.height - 1,
        'second question is below the first',
      );
      assert.equal(await form.getByRole('tablist').count(), 0);
    }
    async function publish(state) {
      await page.evaluate(async (state) => {
        window.publishAsk(state);
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      }, state);
    }
    page.on('pageerror', (error) => errors.push(error.message));
    await t.test(
      'read-only conversations show both answers together, including a failed question',
      async () => {
        await page.goto(origin + '/?paired-readonly');
        await turn.waitFor();
        await publish({ pending: ['first'] });
        await assertStacked();
        for (const question of [firstQuestion, secondQuestion]) {
          assert.equal(
            await question.locator('textarea:enabled, input:enabled').count(),
            0,
          );
        }
        assert.equal(await submit.count(), 0);
        await publish({
          pending: [],
          results: { first: '已存周期', second: '已存品种' },
        });
        await firstQuestion.getByText('已存周期', { exact: true }).waitFor();
        await secondQuestion.getByText('已存品种', { exact: true }).waitFor();
        await assertStacked();
        await publish({
          pending: [],
          results: { first: '已存周期' },
          errors: { second: '品种无效' },
        });
        await firstQuestion.getByText('已存周期', { exact: true }).waitFor();
        await secondQuestion.getByText('品种无效', { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.records), []);
        assert.deepEqual(await page.evaluate(() => window.batchRecords), []);
      },
    );
    await t.test(
      'stacked questions with null option descriptions keep independent drafts and submit once',
      async () => {
        await page.goto(origin + '/?paired');
        await turn.waitFor();
        await publish({ visible: ['first'], groups: [], pending: ['first'] });
        await turn.getByRole('textbox').fill('先填的周期');
        await publish({ pending: ['first'] });
        await assertStacked();
        assert.equal(
          await firstQuestion.getByRole('textbox').inputValue(),
          '先填的周期',
        );
        await firstQuestion.getByRole('textbox').fill('');
        await page
          .locator('[data-chat-turn="previous-turn"]')
          .getByText('此前答案', { exact: true })
          .waitFor();
        await secondQuestion.getByRole('button', { name: '螺纹钢' }).click();
        await secondQuestion.getByRole('textbox').fill('铜');
        assert.equal(await submit.isDisabled(), true);
        await firstQuestion.getByRole('button', { name: '按周' }).click();
        assert.equal(
          await secondQuestion
            .getByRole('button', { name: '螺纹钢' })
            .getAttribute('aria-pressed'),
          'true',
        );
        assert.equal(
          await secondQuestion.getByRole('textbox').inputValue(),
          '铜',
        );
        await publish({ pending: ['first'], running: true });
        assert.ok(await secondQuestion.getByRole('textbox').isEnabled());
        assert.ok(
          await submit.isDisabled(),
          'a recorded interaction can precede the suspended status',
        );
        await publish({ pending: ['first'] });
        assert.equal(await submit.isEnabled(), true);
        assert.deepEqual(await page.evaluate(() => window.batchRecords), []);
        await submit.click();
        const sent = await page.evaluate(() => window.batchRecords);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].interactionId, 'interaction-first');
        assert.deepEqual(
          sent[0].answers.map(({ toolCallId, response }) => [
            toolCallId,
            response.action,
            response.data,
          ]),
          [
            ['first', 'resume', '按周'],
            ['second', 'resume', ['螺纹钢', '铜']],
          ],
        );
        const responseIds = sent[0].answers.map(({ response }) => response.id);
        assert.ok(
          responseIds.every((id) => typeof id === 'string' && id.length > 0),
        );
        assert.equal(new Set(responseIds).size, 2);
        await publish({
          pending: [],
          running: true,
          results: { first: '按周' },
        });
        await publish({ pending: ['second'], results: { first: '按周' } });
        await publish({
          pending: [],
          results: { first: '按周', second: ['螺纹钢', '铜'] },
        });
        await firstQuestion.getByText('按周', { exact: true }).waitFor();
        await secondQuestion.getByText(/螺纹钢.*铜/).waitFor();
        await assertStacked();
        assert.equal(await turn.getByRole('textbox').count(), 0);
        assert.equal(await page.evaluate(() => window.batchRecords.length), 1);
        assert.deepEqual(await page.evaluate(() => window.records), []);
      },
    );
    await t.test(
      'a new suspension after batch acceptance lets the user retry just the remaining answer',
      async () => {
        await page.goto(origin + '/?paired');
        await turn.waitFor();
        await publish({ pending: ['first'] });
        await firstQuestion.getByRole('button', { name: '按周' }).click();
        await secondQuestion.getByRole('textbox').fill('铜');
        await submit.click();
        await secondQuestion.getByText('铜', { exact: true }).waitFor();
        await publish({ pending: ['second'], results: { first: '按周' } });
        await firstQuestion.getByText('按周', { exact: true }).waitFor();
        assert.equal(
          await secondQuestion.getByRole('textbox').inputValue(),
          '铜',
        );
        await secondQuestion.getByRole('textbox').fill('铝');
        await submit.click();
        const sent = await page.evaluate(() => window.batchRecords);
        assert.deepEqual(
          sent.map(({ interactionId, answers }) => [
            interactionId,
            answers.map((answer) => [answer.toolCallId, answer.response.data]),
          ]),
          [
            [
              'interaction-first',
              [
                ['first', '按周'],
                ['second', ['铜']],
              ],
            ],
            ['interaction-second', [['second', ['铝']]]],
          ],
        );
        await secondQuestion.getByText('铝', { exact: true }).waitFor();
        // A terminal snapshot can retain the last recorded suspension.
        await publish({
          pending: ['second'],
          status: 'canceled',
          results: { first: '按周' },
        });
        const unfinished = secondQuestion.getByRole('textbox');
        assert.equal(await unfinished.isDisabled(), true);
        assert.equal(await unfinished.inputValue(), '');
        assert.equal(
          await secondQuestion.getByText('铝', { exact: true }).count(),
          0,
        );
        assert.equal(await submit.count(), 0);
        await firstQuestion.getByText('按周', { exact: true }).waitFor();
      },
    );
    await t.test(
      'a partially answered group reopens and can explicitly skip the remaining question',
      async () => {
        await page.goto(origin + '/?paired');
        await turn.waitFor();
        await publish({
          pending: ['second'],
          results: { first: '上次提交的周期' },
        });
        await firstQuestion
          .getByText('上次提交的周期', { exact: true })
          .waitFor();
        assert.equal(await submit.isDisabled(), true);
        await secondQuestion.getByRole('button', { name: '跳过此题' }).click();
        await secondQuestion.getByRole('button', { name: '恢复作答' }).click();
        assert.equal(await submit.isDisabled(), true);
        await secondQuestion.getByRole('button', { name: '跳过此题' }).click();
        await submit.click();
        const records = await page.evaluate(() => window.batchRecords);
        assert.equal(records.length, 1);
        assert.equal(records[0].interactionId, 'interaction-second');
        assert.deepEqual(
          records[0].answers.map(({ toolCallId, response }) => [
            toolCallId,
            response.action,
          ]),
          [['second', 'decline']],
        );
        await publish({
          pending: [],
          results: { first: '上次提交的周期', second: null },
        });
        await firstQuestion
          .getByText('上次提交的周期', { exact: true })
          .waitFor();
        await secondQuestion.getByText('已跳过', { exact: true }).waitFor();
        assert.equal(await form.getByRole('textbox').count(), 0);
        assert.equal(await submit.count(), 0);
      },
    );
    await t.test(
      'ungrouped questions from different steps stay independent as message parts arrive',
      async () => {
        await page.goto('http://127.0.0.1:' + port + '/?paired');
        const turn = page.locator('[data-chat-turn="ask-turn"]');
        await turn.waitFor();
        await page.evaluate(() =>
          window.publishAsk({
            visible: [],
            groups: [],
            pending: ['second', 'first'],
            laterTurn: true,
          }),
        );
        const second = turn.getByRole('group', {
          name: '填写交易品种',
          exact: true,
        });
        await second.getByRole('textbox').fill('铜');
        await page.evaluate(() =>
          window.publishAsk({
            pending: ['second', 'first'],
            groups: [],
            laterTurn: true,
          }),
        );
        await page.waitForFunction(
          () =>
            document
              .querySelector('form')
              ?.closest('[role="group"]')
              ?.getAttribute('aria-label') === '选择回测周期',
        );
        assert.equal(await turn.getByRole('textbox').count(), 2);
        assert.equal(await page.getByRole('textbox').count(), 2);
        await page
          .getByRole('group', { name: '以前的问题', exact: true })
          .getByText('此前答案', { exact: true })
          .waitFor();
        assert.equal(await second.getByRole('textbox').inputValue(), '铜');
        await second.locator('button[type="submit"]').click();
        await page.evaluate(() =>
          window.publishAsk({
            pending: ['first'],
            groups: [],
            results: { second: ['铜'] },
          }),
        );
        const first = turn.getByRole('group', {
          name: '选择回测周期',
          exact: true,
        });
        await first.getByRole('button', { name: '按周' }).click();
        await first.locator('button[type="submit"]').click();
        assert.deepEqual(await page.evaluate(() => window.records), [
          { id: 'interaction-second', action: 'resume', data: ['铜'] },
          { id: 'interaction-first', action: 'resume', data: '按周' },
        ]);
      },
    );
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
          assert.equal(await currentTurn.getByRole('tablist').count(), 0);
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
