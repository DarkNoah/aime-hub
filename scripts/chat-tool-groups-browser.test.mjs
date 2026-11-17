/** Production hook and renderers with an isolated transport/API fixture. */
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
const [{ createServer }, { default: react }, { default: tailwindcss }, { default: playwright }] = await Promise.all([
  load('vite'), load('@vitejs/plugin-react'), load('@tailwindcss/vite'),
  import(pathToFileURL(serverRequire.resolve('playwright-core')).href),
]);

test('chat lazily opens individual tool groups with paging, cache and streaming revisions', { timeout: 120000 }, async (t) => {
  const fixture = await mkdtemp(path.join(webRoot, '.tool-groups-test-'));
  let vite, browser;
  t.after(async () => {
    await Promise.allSettled([browser?.close(), vite?.close()]);
    await rm(fixture, { recursive: true, force: true });
  });
  await writeFile(path.join(fixture, 'transport.ts'), `
export class SharedEventSource extends EventTarget {
 constructor(){super();window.source=this;queueMicrotask(()=>this.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(window.snapshot)})));}
 close(){}
}`);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
  await writeFile(path.join(fixture, 'entry.tsx'), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTurns} from '/src/components/chat/chat-turns';
import {useThreadChat} from '/src/components/chat/use-thread-chat';
import {chatApi} from '/src/components/chat/api';
import {MessagePreviewContext} from '/src/components/chat/message-preview/context';
import {SessionContext} from '/src/features/auth/session-context';
import {ThemeProvider} from '/src/components/theme/theme-provider';
import {initializeI18n} from '/src/i18n';
import '/src/index.css';
const group=(id,count,display={})=>({type:'data-tool-group',data:{id,count,statusCounts:{success:count,failed:0,running:0},revision:id+'-v1',state:'completed',...display}});
const longToolName='mcp__workspace__inspect_cross_project_dependency_and_permission_graph__'.repeat(3);
window.longToolName=longToolName;
const tool=(id)=>({...(id==='step_07'?{type:'dynamic-tool',toolName:longToolName}:{type:'tool-'+id}),toolCallId:id,state:'output-available',input:{path:id+'.txt'},output:'Result '+id});
const user={id:'turn',role:'user',parts:[{type:'text',text:'请分析并展示执行结果'}]};
const image={type:'tool-image_gen',toolCallId:'image',forceRender:true,state:'output-available',input:{},output:{file_path:'generated.png',content:[{type:'image',mimeType:'image/png',url:'data:image/png;base64,${png}'}]}};
const speech={type:'tool-speech',toolCallId:'speech',forceRender:true,state:'output-available',input:{},output:{file_path:'speech.wav',duration:1,sample_rate:24000}};
const ask={type:'tool-ask_user',toolCallId:'ask',forceRender:true,state:'output-available',input:{question:'你选择哪个方案？',options:[{label:'方案 A'},{label:'方案 B'}],selectionMode:'single_select'},output:'方案 A'};
const panel={type:'tool-intelligent_ui',toolCallId:'panel',forceRender:true,state:'output-available',input:{html:'<p>交互面板内容</p>',title:'结果面板',waitForResponse:false},output:{ok:true}};
window.snapshot={thread:{id:'thread',title:'Fixture',status:'running',projectId:null,queue:[],queueCount:0},activeMessageId:'assistant',activeTurnId:'turn',canContinue:false,turns:[{id:'turn',user,assistant:{id:'assistant',role:'assistant',parts:[{type:'text',text:'正在分析第一部分',state:'streaming'},group('first',22),{type:'text',text:'第一部分已完成'},image,group('second',1,{reasoningIndex:0}),{type:'text',text:'分析结束'},speech,ask,panel,group('earlier-reasoning',0,{reasoningIndex:0,reasoningOnly:true}),{type:'text',text:'继续核对'},group('reasoning',0,{reasoningIndex:1,reasoningOnly:true})]},toolCount:23,assetRevision:'media',revision:'initial'}],toolInteractions:[],history:{cursor:null,hasMore:false}};
window.snapshot.turns.unshift({id:'history-turn',user:{id:'history-user',role:'user',parts:[{type:'text',text:'历史问题'}]},assistant:{id:'history-assistant',role:'assistant',parts:[group('history-reasoning',0,{reasoningIndex:0,reasoningOnly:true}),{type:'text',text:'历史回复'},group('history-tools',1,{reasoningIndex:0})]},toolCount:1,assetRevision:'',revision:'history'});
window.calls=[];window.wholeTurnCalls=0;
chatApi.turn=async()=>{window.wholeTurnCalls++;throw new Error('Whole turn loading is forbidden');};
chatApi.toolGroup=async(threadId,turnId,groupId,cursor,page=0)=>{
 window.calls.push({groupId,page});
 if(window.failNextGroup===groupId){window.failNextGroup=null;throw new Error('Fixture detail failure');}
 const group=window.snapshot.turns.find(turn=>turn.id===turnId).assistant.parts.find(part=>part.type==='data-tool-group'&&part.data.id===groupId).data;
 await new Promise(resolve=>setTimeout(resolve,25));
 const reasoning=(text)=>({type:'reasoning',text,state:'done'});
 const all=groupId==='first'?Array.from({length:22},(_,i)=>tool('step_'+String(i).padStart(2,'0'))):groupId==='second'?[reasoning('中途推理应隐藏'),tool('second_tool')]:groupId==='history-tools'?[reasoning('历史混合思考应隐藏'),tool('history_tool')]:groupId==='reasoning'?[reasoning('同组较早思考应隐藏'),reasoning('核对推理信息')]:groupId==='next-reasoning'?[reasoning('新回复思考')]:[reasoning('较早思考应隐藏')];
 return {id:groupId,revision:group.revision,messages:[{id:'source-'+groupId,role:'assistant',parts:all.slice(page*20,(page+1)*20)}],page,hasMore:(page+1)*20<all.length};
};
window.update=(groupId,revision,display={})=>{
 window.snapshot={...window.snapshot,turns:window.snapshot.turns.map(turn=>({...turn,revision:turn.revision+'x',assistant:{...turn.assistant,parts:turn.assistant.parts.map(part=>part.type==='data-tool-group'&&part.data.id===groupId?{...part,data:{...part.data,revision,...display}}:part)}}))};
 window.source.dispatchEvent(new MessageEvent('update',{data:JSON.stringify({...window.snapshot,history:undefined})}));
};
function App(){const chat=useThreadChat('thread',undefined,{receiveSpeech:false});window.chat=chat;return <main style={{maxWidth:760,margin:'24px auto',padding:16}}><MessagePreviewContext.Provider value={part=>{window.previewed=part;}}><ChatTurns turns={chat.turns} groupDetails={chat.groupDetails} loadGroupDetails={chat.loadGroupDetails} threadId="thread" running activeTurnId={chat.activeTurnId} activeMessageId={chat.activeMessageId} toolInteractions={chat.toolInteractions} onToolResponse={chat.respondToTool} disabled={false}/></MessagePreviewContext.Provider></main>;}
await initializeI18n();
createRoot(document.getElementById('root')).render(<SessionContext.Provider value={{data:{session:{id:'fixture-session'},user:{id:'fixture-user'}}}}><ThemeProvider><App/></ThemeProvider></SessionContext.Provider>);
`);
  vite = await createServer({
    root: webRoot, configFile: false, envFile: false,
    cacheDir: path.join(fixture, 'node_modules/.vite'),
    resolve: { alias: {
      '@/components/realtime/event-source': path.join(fixture, 'transport.ts'),
      '@': path.join(webRoot, 'src'),
    } },
    plugins: [react(), tailwindcss(), {
      name: 'tool-groups-test',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith('/api/threads/thread/files/raw?')) {
            const wav = Buffer.alloc(44 + 48000);
            wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(48000,40);
            res.setHeader('Content-Type', 'audio/wav');res.end(wav);return;
          }
          if (req.url?.split('?')[0] !== '/') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml('/', '<!doctype html><html><body><div id="root"></div><script type="module" src="/' + path.relative(webRoot, path.join(fixture, 'entry.tsx')) + '"></script></body></html>'));
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.badgeAnimations=[];
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(...args){
      const status=this.getAttribute('data-tool-group-status');
      if(status)window.badgeAnimations.push(status);
      return animate.apply(this,args);
    };
  });
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const resetViewportForScreenshot=async()=>{
    await page.locator('[data-chat-tool-group] [data-slot="scroll-area-viewport"]').evaluateAll(viewports=>viewports.forEach(viewport=>{viewport.scrollTop=0;}));
    await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
    await page.mouse.move(0,0);
  };
  await page.goto('http://127.0.0.1:'+vite.httpServer.address().port);
  const first=page.locator('[data-chat-tool-group="first"]');
  const second=page.locator('[data-chat-tool-group="second"]');
  await first.waitFor();
  await page.getByText('正在分析第一部分',{exact:true}).waitFor();
  await page.getByRole('img',{name:'generated.png',exact:true}).waitFor();
  await page.locator('audio').waitFor({state:'attached'});
  await page.getByText('你选择哪个方案？',{exact:true}).waitFor();
  await page.locator('iframe[title="结果面板"]').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls),[]);
  assert.equal(await page.locator('[data-chat-tool-group="history-reasoning"]').count(),0,'historical pure reasoning groups stay hidden');
  assert.equal(await page.locator('[data-chat-tool-group="earlier-reasoning"]').count(),0,'earlier reasoning groups in the latest turn stay hidden');
  assert.equal(await page.locator('[data-chat-tool-group="history-tools"]').count(),1,'hiding reasoning must not remove historical tool groups');
  const firstToggle=first.locator('button[aria-expanded]').first();
  const statusBadges=firstToggle.locator('[data-tool-group-status]');
  assert.deepEqual(await statusBadges.allTextContents(),['成功22']);
  assert.deepEqual(await page.evaluate(()=>window.badgeAnimations),[],'initial counts do not animate');
  assert.equal(await firstToggle.getAttribute('aria-expanded'),'false');
  assert.ok((await firstToggle.boundingBox()).height>=44,'group headers keep a usable touch target');
  await resetViewportForScreenshot();
  await first.screenshot({path:'/tmp/chat-tool-group-collapsed.png'});
  await firstToggle.focus();
  await firstToggle.press('Enter');
  await first.getByText('step_19',{exact:true}).waitFor();
  assert.deepEqual(await statusBadges.allTextContents(),['成功22'],'counts cover the entire group before the next detail page is loaded');
  assert.equal(await firstToggle.getAttribute('aria-expanded'),'true');
  assert.equal(await firstToggle.evaluate(trigger=>{
    const controls=trigger.getAttribute('aria-controls');
    const content=controls&&document.getElementById(controls);
    return !!content&&trigger.closest('[data-chat-tool-group]').contains(content)&&!!content.querySelector('[data-chat-tool-group-detail]');
  }),true,'aria-controls points to this group content');
  const longToolName=await page.evaluate(()=>window.longToolName);
  const longToolButton=first.getByRole('button',{name:new RegExp(longToolName)});
  assert.equal(await longToolButton.count(),1,'truncated names preserve the complete accessible label');
  assert.equal(await first.getByText(longToolName,{exact:true}).evaluate(label=>label.closest('[title]')?.getAttribute('title')),longToolName);
  await resetViewportForScreenshot();
  await first.screenshot({path:'/tmp/chat-tool-group-expanded.png'});
  await longToolButton.click();
  await page.waitForFunction(()=>window.previewed?.toolCallId==='step_07');
  assert.deepEqual(await page.evaluate(()=>({input:window.previewed.input,output:window.previewed.output})),{input:{path:'step_07.txt'},output:'Result step_07'},'the preview callback receives the loaded full tool part');
  assert.equal(await longToolButton.getAttribute('aria-expanded'),null,'preview rows are actions, not nested expansion toggles');
  assert.deepEqual(await page.evaluate(()=>window.calls),[{groupId:'first',page:0}]);
  assert.equal(await second.locator('[data-chat-tool-group-detail]').count(),0);
  const viewport=first.locator('[data-slot="scroll-area-viewport"]').first();
  assert.equal(await viewport.evaluate(viewport=>viewport.clientHeight>0&&viewport.clientHeight<=Math.min(384,innerHeight*.6)+1&&viewport.scrollHeight>viewport.clientHeight),true,'tool details use a bounded scroll area');
  const loadMoreButton=first.getByRole('button',{name:'加载更多工具详情',exact:true});
  assert.equal(await loadMoreButton.evaluate(button=>!!button.closest('[data-slot="scroll-area-viewport"]')),false,'the paging action remains outside the scrolling detail list');
  await viewport.evaluate(viewport=>{viewport.scrollTop=viewport.scrollHeight;});
  const lastRowInView=async(name)=>first.getByText(name,{exact:true}).evaluate(label=>{
    const row=label.getBoundingClientRect();const viewport=label.closest('[data-slot="scroll-area-viewport"]').getBoundingClientRect();return row.top>=viewport.top-1&&row.bottom<=viewport.bottom+1;
  });
  assert.equal(await lastRowInView('step_19'),true,'the final loaded tool is reachable by scrolling');
  const scrollBeforePage=await viewport.evaluate(viewport=>viewport.scrollTop);
  await loadMoreButton.click();
  await first.getByText('step_21',{exact:true}).waitFor();
  assert.ok(Math.abs((await viewport.evaluate(viewport=>viewport.scrollTop))-scrollBeforePage)<=2,'appending a tool page preserves the current scroll position');
  await viewport.evaluate(viewport=>{viewport.scrollTop=viewport.scrollHeight;});
  assert.equal(await lastRowInView('step_21'),true,'new tools remain reachable after paging');
  const order=await first.locator('[data-chat-tool-group-detail] button').allTextContents();
  assert.ok(order.findIndex(text=>text.includes('step_00'))<order.findIndex(text=>text.includes('step_20')));
  assert.equal(await first.getByText('step_00',{exact:true}).count(),1);
  await firstToggle.press('Space');
  assert.equal(await firstToggle.getAttribute('aria-expanded'),'false');
  assert.equal(await firstToggle.evaluate(trigger=>document.activeElement===trigger),true);
  await firstToggle.press('Enter');
  assert.equal(await firstToggle.getAttribute('aria-expanded'),'true');
  await first.getByText('step_21',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.length),2);
  await page.evaluate(()=>window.update('missing','text-only'));
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(()=>window.calls.length),2);
  await firstToggle.click();
  await page.emulateMedia({reducedMotion:'no-preference'});
  const updateCounts=async(statusCounts)=>{
    await page.evaluate(statusCounts=>window.update('first','counts-'+JSON.stringify(statusCounts),{
      count:Object.values(statusCounts).reduce((total,count)=>total+count,0),
      statusCounts,
      state:statusCounts.running?'running':statusCounts.failed?'failed':'completed',
    }),statusCounts);
    await page.waitForFunction(statusCounts=>Object.entries(statusCounts).every(([status,count])=>{
      const badge=document.querySelector('[data-chat-tool-group="first"] [data-tool-group-status="'+status+'"]');
      return count===0?!badge:badge?.textContent.endsWith(String(count));
    }),statusCounts);
  };
  await updateCounts({success:22,failed:0,running:1});
  await page.waitForFunction(()=>window.badgeAnimations.length===1);
  await updateCounts({success:22,failed:0,running:2});
  await page.waitForFunction(()=>window.badgeAnimations.length===2);
  await updateCounts({success:22,failed:1,running:1});
  await page.waitForFunction(()=>window.badgeAnimations.length===3);
  assert.deepEqual(await statusBadges.allTextContents(),['成功22','失败1','运行中1']);
  await first.screenshot({path:'/tmp/chat-tool-group-status-counts.png'});
  await updateCounts({success:23,failed:1,running:0});
  await page.waitForFunction(()=>window.badgeAnimations.length===4);
  assert.deepEqual(await page.evaluate(()=>window.badgeAnimations),['running','running','failed','success'],'only increasing counts animate, including rapid successive additions');
  await updateCounts({success:22,failed:0,running:0});
  assert.deepEqual(await statusBadges.allTextContents(),['成功22'],'badges disappear when their counts return to zero');
  await page.waitForTimeout(280);
  assert.equal(await page.evaluate(()=>window.badgeAnimations.length),4,'decreasing counts do not animate');
  await page.emulateMedia({reducedMotion:'reduce'});
  await updateCounts({success:22,failed:0,running:1});
  await page.waitForTimeout(280);
  assert.equal(await page.evaluate(()=>window.badgeAnimations.length),4,'reduced motion disables count animations');
  await updateCounts({success:22,failed:0,running:0});
  assert.equal(await page.evaluate(()=>window.calls.length),2,'live count changes do not fetch collapsed details');
  await page.evaluate(()=>window.update('first','first-v2'));
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(()=>window.calls.length),2);
  await firstToggle.click();
  await page.waitForFunction(()=>window.calls.length===3);
  await first.getByRole('button',{name:'加载更多工具详情',exact:true}).waitFor();
  assert.equal(await first.getByText('step_21',{exact:true}).count(),0);
  await second.locator('button[aria-expanded]').first().click();
  await second.getByText('second_tool',{exact:true}).waitFor();
  assert.equal(await second.getByText('中途推理应隐藏',{exact:true}).count(),0,'earlier reasoning inside a mixed group stays hidden');
  assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{groupId:'second',page:0});
  const before=await page.evaluate(()=>window.calls.length);
  await page.evaluate(()=>{let i=0;window.streamingTimer=setInterval(()=>window.update('first','stream-'+(++i)),30);});
  await page.waitForTimeout(850);
  assert.ok(await page.evaluate(()=>window.calls.length)>before,'continuous revisions must not starve detail reads');
  await page.evaluate(()=>clearInterval(window.streamingTimer));
  await page.locator('[data-chat-tool-group="reasoning"] button[aria-expanded]').first().click();
  await page.getByText('核对推理信息',{exact:true}).waitFor();
  assert.equal(await page.getByText('同组较早思考应隐藏',{exact:true}).count(),0,'only the final reasoning block in a group is displayed');
  assert.equal(await page.getByText('思考过程',{exact:true}).count(),1,'a pure reasoning group has one heading, without an inner duplicate');
  const historyTools=page.locator('[data-chat-tool-group="history-tools"]');
  await historyTools.locator('button[aria-expanded]').first().click();
  await historyTools.getByText('history_tool',{exact:true}).waitFor();
  assert.equal(await historyTools.getByText('历史混合思考应隐藏',{exact:true}).count(),0);
  await resetViewportForScreenshot();
  await page.screenshot({path:'/tmp/chat-tool-groups-desktop.png',fullPage:true});
  await page.waitForFunction(()=>window.chat.groupDetails.get('turn:first')?.summaryRevision===window.snapshot.turns.find(turn=>turn.id==='turn').assistant.parts.find(part=>part.type==='data-tool-group'&&part.data.id==='first').data.revision);
  const callsBeforeTheme=await page.evaluate(()=>window.calls.length);
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));
  await resetViewportForScreenshot();
  await first.screenshot({path:'/tmp/chat-tool-group-expanded-dark.png'});
  await resetViewportForScreenshot();
  await page.screenshot({path:'/tmp/chat-tool-groups-desktop-dark.png',fullPage:true});
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>!document.documentElement.classList.contains('dark'));
  assert.equal(await page.evaluate(()=>window.calls.length),callsBeforeTheme,'theme changes do not refetch tool data');
  await page.evaluate(()=>{window.failNextGroup='second';window.update('second','second-error');});
  await second.getByRole('button',{name:'重试',exact:true}).waitFor();
  await second.getByRole('button',{name:'重试',exact:true}).click();
  await page.waitForFunction(()=>window.chat.groupDetails.get('turn:second')?.summaryRevision==='second-error');
  await page.evaluate(()=>{
    window.snapshot={...window.snapshot,turns:window.snapshot.turns.map(turn=>({...turn,revision:'media-state',assistant:{...turn.assistant,parts:turn.assistant.parts.map(part=>part.toolCallId==='image'?{...part,state:'output-error',output:undefined,errorText:'图片生成失败，请重试'}:part.toolCallId==='speech'?{...part,state:'input-available',output:undefined}:part)}}))};
    window.source.dispatchEvent(new MessageEvent('update',{data:JSON.stringify({...window.snapshot,history:undefined})}));
  });
  await page.getByText('图片生成失败，请重试',{exact:true}).waitFor();
  await page.getByText('speech',{exact:true}).waitFor();
  assert.equal(await page.locator('audio').count(),0);
  await page.setViewportSize({width:390,height:844});
  await resetViewportForScreenshot();
  await page.screenshot({path:'/tmp/chat-tool-groups-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await longToolButton.evaluate(button=>button.getBoundingClientRect().right<=innerWidth),true,'long tool names stay inside the mobile viewport');
  await resetViewportForScreenshot();
  await first.screenshot({path:'/tmp/chat-tool-group-mobile.png'});
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));
  await resetViewportForScreenshot();
  await page.screenshot({path:'/tmp/chat-tool-groups-mobile-dark.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>!document.documentElement.classList.contains('dark'));
  await page.evaluate(()=>{
    const next={id:'next-turn',user:{id:'next-user',role:'user',parts:[{type:'text',text:'继续新的问题'}]},assistant:{id:'next-assistant',role:'assistant',parts:[{type:'text',text:'新的回复正在加载',state:'streaming'}]},toolCount:0,assetRevision:'',revision:'next'};
    window.snapshot={...window.snapshot,activeTurnId:next.id,activeMessageId:'next-assistant',turns:[...window.snapshot.turns,next]};
    window.source.dispatchEvent(new MessageEvent('update',{data:JSON.stringify({...window.snapshot,history:undefined})}));
  });
  await page.getByText('新的回复正在加载',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-chat-tool-group="reasoning"]').count(),0,'starting a new reply removes the prior reply reasoning');
  assert.equal(await page.getByText('核对推理信息',{exact:true}).count(),0);
  assert.equal(await page.getByText('思考过程',{exact:true}).count(),0);
  assert.equal(await second.getByText('second_tool',{exact:true}).count(),1,'already expanded tool details remain available');
  await page.evaluate(()=>{
    window.snapshot={...window.snapshot,turns:window.snapshot.turns.map(turn=>turn.id!=='next-turn'?turn:{...turn,revision:'next-reasoning',assistant:{...turn.assistant,parts:[...turn.assistant.parts,{type:'data-tool-group',data:{id:'next-reasoning',count:0,statusCounts:{success:0,failed:0,running:0},revision:'next-v1',state:'completed',reasoningIndex:0,reasoningOnly:true}}]}})};
    window.source.dispatchEvent(new MessageEvent('update',{data:JSON.stringify({...window.snapshot,history:undefined})}));
  });
  await page.locator('[data-chat-tool-group="next-reasoning"] button[aria-expanded]').first().click();
  await page.getByText('新回复思考',{exact:true}).waitFor();
  assert.equal(await page.getByText('思考过程',{exact:true}).count(),1);
  assert.equal(await page.getByText('核对推理信息',{exact:true}).count(),0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{
    window.badgeAnimations=[];
    window.update('next-reasoning','first-tool',{
      count:1,statusCounts:{success:0,failed:0,running:1},state:'running',reasoningOnly:false,
    });
  });
  await page.waitForFunction(()=>window.badgeAnimations.length===1);
  assert.deepEqual(await page.evaluate(()=>window.badgeAnimations),['running'],'the first tool added to an existing reasoning group animates');
  assert.equal(await page.evaluate(()=>window.wholeTurnCalls),0);
  assert.deepEqual(errors,[]);
});
