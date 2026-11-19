import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { RequestContext } from '@mastra/core/request-context';
import { isValidationError, noopObserve } from '@mastra/core/tools';
import { createExecTool } from '../../mastra/tools/exec.js';
import type { BrowserExecBinding } from './browser/exec-actions.js';
import { NetworkCaptureStore } from './browser/network-store.js';
import { ThreadBrowsers } from './browser/registry.js';

type Listing = Awaited<ReturnType<NetworkCaptureStore['list']>>;
type Detail = Awaited<ReturnType<NetworkCaptureStore['read']>>;

async function findCompleted(exec: BrowserExecBinding, url: string) {
  const deadline = Date.now() + 5000;
  do {
    const result = (await exec('list', { url })) as Listing;
    const entry = result.entries.find(
      (item) => item.state === 'finished' && new URL(item.url).pathname === url,
    );
    if (entry) return (await exec('read', { id: entry.id })) as Detail;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('No finished network record for ' + url);
}

test(
  'network recording spans navigation, clicks, popups and manual input, isolated per thread',
  { skip: process.env.BROWSER_INTEGRATION !== '1', timeout: 45_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'network-browser-test-'));
    const createBrowsers = () =>
      new ThreadBrowsers(
        join(root, 'profiles'),
        undefined,
        undefined,
        new NetworkCaptureStore({
          directory: join(root, 'captures'),
          secret: 'test-secret-for-chat-browser-history',
        }),
      );
    let browsers = createBrowsers();
    let holdResponse!: (send: () => void) => void;
    const delayed = new Promise<() => void>((resolve) => {
      holdResponse = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/popup' }).end();
        return;
      }
      if (request.url === '/delayed') {
        holdResponse(() => {
          const data = gzipSync('{"done":true}');
          response
            .writeHead(200, {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': data.length,
            })
            .end(data);
        });
        return;
      }
      if (request.url?.startsWith('/submit')) {
        const json = JSON.stringify({
          saved: true,
          access_token: 'private-response-token',
        });
        response
          .writeHead(201, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(json),
            'set-cookie': 'sid=private-response-cookie',
          })
          .end(json);
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<button id="save" onclick="save()">Save</button>' +
            '<a id="open" href="/redirect" target="_blank" rel="opener">Details</a>' +
            '<script>function save(){return fetch("/submit?token=private-url-token",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer private-header-token"},body:JSON.stringify({sample:1,password:"private-request-password"})})}</script>',
        );
    });
    t.after(async () => {
      await browsers.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = 'http://127.0.0.1:' + address.port;
    const first = browsers.execForThread('first', 'owner', 'project');
    const second = browsers.execForThread('second', 'owner', 'project');
    const otherUser = browsers.execForThread('first', 'other', 'project');

    const requestContext = new RequestContext();
    requestContext.set('execBrowser', first);
    const tool = createExecTool({ getTools: async () => [] });
    async function inChat(code: string) {
      const result = await tool.execute!(
        {
          code: "import { browser } from 'browser'; " + code,
          yield_time_ms: 5_000,
          max_output_tokens: 1000,
        },
        { requestContext, observe: noopObserve },
      );
      assert.ok(result && !isValidationError(result));
      assert.ok(!result.isError, JSON.stringify(result.content));
      return result.content;
    }
    await Promise.all([inChat('await browser.start()'), second('start', {})]);
    assert.equal(browsers.get('first', 'owner'), undefined);
    await Promise.all([
      first('goto', { url: base + '/first' }),
      second('goto', { url: base + '/second' }),
    ]);
    const document = await findCompleted(first, '/first');
    assert.equal(document.method, 'GET');
    assert.equal(document.status, 200);
    assert.equal(
      ((await first('list', { url: '/second' })) as Listing).total,
      0,
    );
    await assert.rejects(second('read', { id: document.id }));
    await assert.rejects(otherUser('read', { id: document.id }));

    await first('click', { target: '#save' });
    const submitted = await findCompleted(first, '/submit');
    assert.equal(submitted.method, 'POST');
    assert.equal(submitted.status, 201);
    assert.match(submitted.requestBody ?? '', /"sample"\s*:\s*1/);
    assert.match(submitted.responseBody ?? '', /"saved"\s*:\s*true/);
    assert.doesNotMatch(
      JSON.stringify(submitted),
      /private-(?:url|header|request|response)-/,
    );
    assert.deepEqual(
      await inChat(`
      const { entries } = await browser.list({ url: '/submit', method: 'POST', status: 201 });
      const record = await browser.read(entries[0].id);
      text(JSON.parse(record.responseBody).saved);
    `),
      [{ type: 'text', text: 'true' }],
    );

    await first('click', { target: '#open' });
    const popup = await findCompleted(first, '/popup');
    const redirect = await findCompleted(first, '/redirect');
    assert.equal(popup.redirectedFrom, redirect.id);
    await browsers
      .get('first', 'owner')!
      .action({ kind: 'navigate', url: base + '/manual' });
    await findCompleted(first, '/manual');
    await first('evaluate', { script: 'void fetch("/delayed"); true' });
    const finishResponse = await delayed;
    await inChat('await browser.stop()');
    finishResponse();
    const completedAfterStop = await findCompleted(first, '/delayed');
    assert.deepEqual(JSON.parse(completedAfterStop.responseBody ?? 'null'), {
      done: true,
    });
    await first('goto', { url: base + '/after-stop' });
    await first('close', {});
    assert.equal(
      ((await first('list', { url: '/after-stop' })) as Listing).total,
      0,
    );
    assert.equal(
      ((await first('read', { id: submitted.id })) as Detail).status,
      201,
    );
    assert.equal(((await second('list', {})) as Listing).active, false);
    await browsers.dispose();
    browsers = createBrowsers();
    const restored = browsers.execForThread('first', 'owner', 'project');
    requestContext.set('execBrowser', restored);
    assert.deepEqual(
      await inChat(`
        const history = await browser.list({ method: 'POST', status: 201 });
        const record = await browser.read(history.entries[0].id);
        text([history.active, record.id, JSON.parse(record.responseBody).saved]);
      `),
      [{ type: 'text', text: JSON.stringify([false, submitted.id, true]) }],
    );
    assert.equal(browsers.get('first', 'owner'), undefined);
    await browsers.remove('first');
    await assert.rejects(restored('read', { id: submitted.id }));
  },
);
