import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { defaultWebFetchConfig } from '@aime/shared/tools';
import { createWebFetchTool } from '../apps/server/src/mastra/tools/web_fetch.js';
import { LocalProvider } from '../apps/server/src/mastra/providers/local.js';
import {
  readBrowserPage,
  readWebPage,
} from '../apps/server/src/mastra/web/page.js';
import type { WebResource } from '../apps/server/src/mastra/web/request.js';

const url = 'https://example.com/article';
const config = { ...defaultWebFetchConfig, timeoutMs: 15000 };
const validateUrl = async () => ({ address: '93.184.216.34', family: 4 });
const html = `<html><body><article><h1>Article</h1><p>${'Readable article content with enough text to extract. '.repeat(12)}</p></article></body></html>`;
const resource = (body: string): WebResource => ({
  body: Buffer.from(body),
  status: 200,
  headers: { 'content-type': 'text/html' },
  url,
});

async function execute(tool: ReturnType<typeof createWebFetchTool>) {
  const output = await tool.execute!(
    { url },
    {
      abortSignal: new AbortController().signal,
      observe: { span: async (_name, fn) => fn(), log: () => {} },
    },
  );
  assert.ok(output && 'content' in output);
  return output;
}

test('web_fetch handles empty browser content during asynchronous cleanup and remains usable', async (t) => {
  const { chromium } = await import('../apps/server/src/lib/browser.js');
  let content = '<html><body></body></html>';
  let closed = 0;
  t.mock.method(
    chromium,
    'launch',
    async () =>
      ({
        newContext: async () => ({
          routeWebSocket: async () => {},
          route: async () => {},
          newPage: async () => ({
            goto: async () => ({ ok: () => true }),
            url: () => url,
            waitForLoadState: async () => {},
            content: async () => content,
          }),
        }),
        close: async () => {
          // Real browser shutdown yields to the event loop. Extraction errors
          // must already be handled while this cleanup is still pending.
          await nextTurn();
          closed++;
        },
      }) as unknown as Awaited<ReturnType<typeof chromium.launch>>,
  );
  const tool = createWebFetchTool(config, {
    validateUrl,
    fallbackProvider: new LocalProvider({
      readDirect: (target, options) =>
        readWebPage(target, options, async () =>
          resource('<html><body></body></html>'),
        ),
    }),
  });
  const failed = await execute(tool);
  assert.equal(failed.ok, false);
  assert.equal(failed.isError, true);
  assert.match(failed.content, /Web fetch failed/);
  assert.equal(closed, 1);

  content = html;
  const recovered = await execute(tool);
  assert.equal(recovered.ok, true);
  assert.match(recovered.content, /article content/);
  assert.equal(closed, 2);
});

test(
  'empty browser pages reject safely and subsequent browser reads still succeed',
  { skip: process.env.TEST_WEB_FETCH_BROWSER !== '1', timeout: 30000 },
  async () => {
    await assert.rejects(
      readBrowserPage(url, AbortSignal.timeout(15000), 15000, async () =>
        resource('<html><body></body></html>'),
      ),
      /No readable page content/,
    );
    const result = await readBrowserPage(
      url,
      AbortSignal.timeout(15000),
      15000,
      async () => resource(html),
    );
    assert.match(result.content, /article content/);
  },
);
