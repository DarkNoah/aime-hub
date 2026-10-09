import assert from 'node:assert/strict';
import test from 'node:test';
import { SerpApiProvider } from '../apps/server/src/mastra/providers/serpapi.js';
import { SogouProvider } from '../apps/server/src/mastra/providers/sogou.js';
import type { WebSearchProvider } from '../apps/server/src/mastra/providers/web-search.js';
import { createWebSearchTool } from '../apps/server/src/mastra/tools/web_search.js';
import { requestProviderJson } from '../apps/server/src/modules/providers/network.js';
import { defaultWebSearchConfig } from '@aime/shared/tools';

const result = {
  title: 'Example',
  href: 'https://example.com/',
  snippet: 'Summary',
};
const config = {
  ...defaultWebSearchConfig,
  providerId: 'configured-provider',
  numResults: 3,
  timeoutMs: 2000,
};
const input = { query: '中文 & query=one #two', numResults: 3 };
function toolContext(
  abortSignal = new AbortController().signal,
): Parameters<
  NonNullable<ReturnType<typeof createWebSearchTool>['execute']>
>[1] {
  return {
    abortSignal,
    observe: { span: async (_name, fn) => fn(), log: () => {} },
  };
}

test('SerpAPI maps organic results and passes credentials, limits and cancellation to the transport', async () => {
  const controller = new AbortController();
  let called = false;
  const provider = new SerpApiProvider(
    {
      apiKey: 'synthetic-key',
      baseUrl: 'https://search.example/proxy/',
      timeoutMs: 2345,
    },
    async (url, key, maxBytes, options) => {
      called = true;
      assert.equal(url, 'https://search.example/proxy/search.json');
      assert.equal(key, 'synthetic-key');
      assert.equal(maxBytes, 2_000_000);
      assert.deepEqual(options, {
        query: { engine: 'google', q: input.query },
        apiKeyParameter: 'api_key',
        signal: controller.signal,
        timeoutMs: 2345,
      });
      return {
        search_metadata: { status: 'Success' },
        search_parameters: { api_key: key },
        organic_results: [
          { title: 'Not a page', link: 'javascript:alert(1)' },
          { title: ' Example ', link: result.href, snippet: result.snippet },
          { title: 'More', link: 'https://example.com/more' },
        ],
      };
    },
  );
  assert.deepEqual(
    await provider.webSearch(
      { ...input, numResults: 1 },
      { abortSignal: controller.signal },
    ),
    [result],
  );
  assert.equal(called, true);
});

test('SerpAPI distinguishes successful empty searches from API and malformed responses', async () => {
  const options = {
    apiKey: 'synthetic-key',
    baseUrl: 'https://serpapi.com',
    timeoutMs: 1000,
  };
  const empty = new SerpApiProvider(options, async () => ({
    search_metadata: { status: 'Success' },
    search_information: { organic_results_state: 'Fully empty' },
    error: "Google hasn't returned any results",
  }));
  assert.deepEqual(await empty.webSearch(input), []);
  for (const data of [
    { error: 'contains synthetic-key' },
    { search_metadata: { status: 'Error' } },
    {},
    null,
    { organic_results: 'invalid' },
  ]) {
    const provider = new SerpApiProvider(options, async () => data);
    await assert.rejects(
      provider.webSearch(input),
      (error: Error) => !error.message.includes('synthetic-key'),
    );
  }
});

test('credential query requests retain HTTPS, public-address and URL protections', async () => {
  const options = { query: { q: 'test' }, apiKeyParameter: 'api_key' };
  for (const url of [
    'http://example.com/search.json',
    'https://127.0.0.1/search.json',
    'https://example.com/search.json?api_key=bad',
  ]) {
    await assert.rejects(
      requestProviderJson(url, 'synthetic-key', 1000, options),
      { code: 'INVALID_URL' },
    );
  }
  await assert.rejects(
    requestProviderJson(
      'https://example.com/search.json',
      'synthetic-key',
      1000,
      { ...options, signal: AbortSignal.abort() },
    ),
  );
});

test('web_search uses provider.webSearch and retains a successful empty result without fallback', async () => {
  for (const results of [[result], []]) {
    const tool = createWebSearchTool(config, {
      resolveProvider: async (id) => {
        assert.equal(id, config.providerId);
        return {
          id: 'serpapi',
          async webSearch(value, options) {
            assert.deepEqual(value, { query: 'query', numResults: 3 });
            assert.ok(options?.abortSignal);
            return results;
          },
        };
      },
      fallbackProvider: {
        id: 'sogou',
        async webSearch() {
          assert.fail('unexpected fallback');
        },
      },
    });
    assert.deepEqual(await tool.execute!({ query: 'query' }, toolContext()), {
      results,
      provider: 'serpapi',
      fallback: false,
    });
  }
});

test('missing, unavailable or failed providers use Sogou, and total failures do not expose secrets', async () => {
  let fallbackCalls = 0;
  const fallbackProvider: WebSearchProvider = {
    id: 'sogou',
    async webSearch() {
      fallbackCalls++;
      return [result];
    },
  };
  for (const providerId of [null, 'missing', 'failed']) {
    const tool = createWebSearchTool(
      { ...config, providerId },
      {
        resolveProvider: async () => {
          if (providerId === 'missing') throw new Error('synthetic-secret');
          return {
            id: 'serpapi',
            async webSearch() {
              throw new Error('synthetic-secret');
            },
          };
        },
        fallbackProvider,
      },
    );
    assert.deepEqual(await tool.execute!({ query: 'query' }, toolContext()), {
      results: [result],
      provider: 'sogou',
      fallback: true,
    });
  }
  assert.equal(fallbackCalls, 3);
  const tool = createWebSearchTool(config, {
    resolveProvider: async () => {
      throw new Error('synthetic-secret');
    },
    fallbackProvider: {
      id: 'sogou',
      async webSearch() {
        throw new Error('synthetic-secret');
      },
    },
  });
  const output = await tool.execute!({ query: 'query' }, toolContext());
  assert.ok(output);
  assert.equal('isError' in output && output.isError, true);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret/);
});

test('a cancelled search never starts or falls back to another engine', async () => {
  const controller = new AbortController();
  let primaryCalls = 0;
  const tool = createWebSearchTool(config, {
    resolveProvider: async () => ({
      id: 'serpapi',
      async webSearch() {
        primaryCalls++;
        controller.abort();
        throw new Error('aborted');
      },
    }),
    fallbackProvider: {
      id: 'sogou',
      async webSearch() {
        assert.fail('cancelled search attempted fallback');
      },
    },
  });
  const first = await tool.execute!(
    { query: 'query' },
    toolContext(controller.signal),
  );
  assert.ok(first);
  assert.equal('isError' in first && first.isError, true);
  await tool.execute!({ query: 'query' }, toolContext(controller.signal));
  assert.equal(primaryCalls, 1);
});

test('Sogou parses direct results and JS/HTTP redirects, skips broken links, deduplicates and bounds results', async () => {
  const visited: URL[] = [];
  const html = `<html><body>
    <div class="vrwrap"><a href="https://wrong.example">decorative link</a><h3><a href="/link?url=js"> JS &amp; result </a><script>trackingCode()</script></h3><div class="str_info"> Some <em>text</em> <style>.hidden{color:red}</style></div></div>
    <div class="vrwrap"><h3><a href="/link?url=broken">Broken</a></h3></div>
    <div class="rb"><h3><a href="/link?url=http">HTTP redirect</a></h3><div>Next</div></div>
    <div class="vrwrap"><h3><a href="https://example.com/direct">Direct</a></h3><div>Direct text</div></div>
    <div class="vrwrap"><h3><a href="https://example.com/direct">Duplicate</a></h3></div>
    <div class="vrwrap"><h3><a href="javascript:alert(1)">Invalid</a></h3></div>
  </body></html>`;
  const provider = new SogouProvider(2000, async (request, init) => {
    const url = new URL(String(request));
    visited.push(url);
    assert.equal(url.origin, 'https://www.sogou.com');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    if (url.pathname === '/web') {
      assert.equal(url.searchParams.get('query'), input.query);
      assert.deepEqual([...url.searchParams.keys()], ['query']);
      return new Response(html);
    }
    if (url.searchParams.get('url') === 'js')
      return new Response(
        `<script>window.location.replace("https://example.com/js");</script>`,
      );
    if (url.searchParams.get('url') === 'http')
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/http' },
      });
    return new Response('Failure', { status: 503 });
  });
  assert.deepEqual(await provider.webSearch(input), [
    {
      title: 'JS & result',
      href: 'https://example.com/js',
      snippet: 'Some text',
    },
    {
      title: 'HTTP redirect',
      href: 'https://example.com/http',
      snippet: 'Next',
    },
    {
      title: 'Direct',
      href: 'https://example.com/direct',
      snippet: 'Direct text',
    },
  ]);
  assert.equal(visited.length, 4);
});

test('Sogou fails explicitly on challenge/empty pages and enforces body size and cancellation', async () => {
  for (const body of ['<html>Captcha required</html>', 'x'.repeat(2_000_001)]) {
    const provider = new SogouProvider(2000, async () => new Response(body));
    await assert.rejects(provider.webSearch(input));
  }
  const provider = new SogouProvider(2000, async () => {
    assert.fail('fetch called after abort');
  });
  await assert.rejects(
    provider.webSearch(input, { abortSignal: AbortSignal.abort() }),
  );
});

test('Sogou requests are aborted when their provider timeout expires', async () => {
  const provider = new SogouProvider(
    10,
    async (_request, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(
          () => reject(new Error('test timeout')),
          1000,
        );
        init!.signal!.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(init!.signal!.reason);
          },
          { once: true },
        );
      }),
  );
  await assert.rejects(provider.webSearch(input), { name: 'TimeoutError' });
});
