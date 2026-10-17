import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import { providerSupportsWebTool } from '@aime/shared/providers';
import {
  defaultWebFetchConfig,
  defaultWebSearchConfig,
} from '@aime/shared/tools';
import { DeepSeekProvider } from '../apps/server/src/mastra/providers/deepseek.js';
import { createWebSearchTool } from '../apps/server/src/mastra/tools/web_search.js';
import { createWebFetchTool } from '../apps/server/src/mastra/tools/web_fetch.js';
import { ProviderService } from '../apps/server/src/modules/providers/service.js';
import type { WebResource } from '../apps/server/src/mastra/web/request.js';

const config = {
  id: 'deepseek-provider',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'synthetic-deepseek-key',
  timeoutMs: 1000,
};
const input = { query: '中文 "exact phrase" site:example.com', numResults: 2 };
const pageUrl = 'https://example.com/article?q=one&two=2#section';
const page = { title: 'Article', content: '# Article\n\nMarkdown content' };
const result = {
  title: 'Example',
  href: 'https://example.com/',
  snippet: 'Short snippet',
  summary: 'Longer summary for the model',
};
const searchResult = { ...result, url: result.href };
const resource = (data: unknown, status = 200): WebResource => ({
  url: config.baseUrl,
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(data)),
});

test('DeepSeek search posts JSON to root, versioned and proxy URLs and keeps both summaries', async () => {
  for (const [baseUrl, endpoint] of [
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/tools/search'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/v1/tools/search'],
    [
      'https://api.deepseek.com/v1/',
      'https://api.deepseek.com/v1/tools/search',
    ],
    [
      'https://proxy.example/deepseek',
      'https://proxy.example/deepseek/v1/tools/search',
    ],
    [
      'https://proxy.example/deepseek/v1/',
      'https://proxy.example/deepseek/v1/tools/search',
    ],
  ]) {
    const provider = new DeepSeekProvider(
      { ...config, baseUrl },
      undefined,
      async (url, options) => {
        assert.equal(url, endpoint);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers?.authorization, `Bearer ${config.apiKey}`);
        assert.equal(options.headers?.['content-type'], 'application/json');
        assert.equal(options.maxBytes, 2_000_000);
        assert.deepEqual(JSON.parse(String(options.body)), {
          query: input.query,
          count: input.numResults,
        });
        return resource({
          results: [
            { ...searchResult, url: 'javascript:alert(1)' },
            { ...searchResult, url: 'https://user:password@example.com' },
            { ...searchResult, title: ' ' },
            { ...searchResult, title: ' Example ' },
            { ...searchResult, title: 'Second' },
            { ...searchResult, title: 'Third' },
          ],
        });
      },
    );
    assert.deepEqual(await provider.webSearch(input), [
      result,
      { ...result, title: 'Second' },
    ]);
  }
});

test('DeepSeek validates Unicode query limits and caps upstream count at 50', async () => {
  let calls = 0;
  const provider = new DeepSeekProvider(
    config,
    undefined,
    async (_, options) => {
      calls++;
      assert.deepEqual(JSON.parse(String(options.body)), {
        query: '😀'.repeat(128),
        count: 50,
      });
      return resource({ results: [] });
    },
  );
  assert.deepEqual(
    await provider.webSearch({
      query: ` ${'😀'.repeat(128)} `,
      numResults: 100,
    }),
    [],
  );
  for (const query of ['', '   ', '😀'.repeat(129)])
    await assert.rejects(provider.webSearch({ ...input, query }));
  for (const numResults of [0, -1, 1.5, NaN])
    await assert.rejects(provider.webSearch({ ...input, numResults }));
  assert.equal(calls, 1);
});

test('DeepSeek fetch posts the complete URL and returns title and Markdown', async () => {
  const provider = new DeepSeekProvider(
    config,
    undefined,
    async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/v1/tools/fetch');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(String(options.body)), { url: pageUrl });
      assert.equal(options.maxBytes, 5_000_000);
      return resource(page);
    },
  );
  assert.deepEqual(await provider.webFetch(pageUrl), {
    ...page,
    url: pageUrl,
    contentType: 'text/markdown',
  });
});

test('DeepSeek rejects unsafe configuration and target URLs before sending credentials', async () => {
  const unexpected = async () => {
    throw new Error('Unexpected transport call');
  };
  for (const patch of [
    { apiKey: '' },
    { baseUrl: 'http://api.deepseek.com' },
    { baseUrl: 'https://api.deepseek.com?key=secret' },
    { baseUrl: 'https://api.deepseek.com#fragment' },
    { baseUrl: 'https://user:password@api.deepseek.com' },
  ]) {
    const provider = new DeepSeekProvider(
      { ...config, ...patch },
      undefined,
      unexpected,
    );
    await assert.rejects(
      provider.webSearch(input),
      (error: Error) => !error.message.includes('Unexpected'),
    );
  }
  const provider = new DeepSeekProvider(config, undefined, unexpected);
  for (const url of [
    'file:///etc/passwd',
    'https://user:password@example.com',
    'invalid',
  ])
    await assert.rejects(
      provider.webFetch(url),
      (error: Error) => !error.message.includes('Unexpected'),
    );
});

test('DeepSeek rejects API errors, redirects, malformed JSON and empty pages without exposing upstream details', async () => {
  const noSecrets = (error: Error) => !error.message.includes(config.apiKey);
  for (const response of [
    ...[302, 400, 401, 402, 403, 404, 429, 500, 504].map((status) =>
      resource({ error: { message: config.apiKey } }, status),
    ),
    { ...resource(null), body: Buffer.from(config.apiKey) },
    resource({ error: { message: config.apiKey } }),
    resource(null),
  ]) {
    const provider = new DeepSeekProvider(
      config,
      undefined,
      async () => response,
    );
    await assert.rejects(provider.webSearch(input), noSecrets);
    await assert.rejects(provider.webFetch(pageUrl), noSecrets);
  }
  for (const data of [
    {},
    { title: '', content: ' ' },
    { title: '', content: 42 },
  ]) {
    const provider = new DeepSeekProvider(config, undefined, async () =>
      resource(data),
    );
    await assert.rejects(provider.webFetch(pageUrl), noSecrets);
  }
  const failed = new DeepSeekProvider(config, undefined, async () => {
    throw new Error(config.apiKey);
  });
  await assert.rejects(failed.webSearch(input), noSecrets);
  await assert.rejects(failed.webFetch(pageUrl), noSecrets);
});

test('DeepSeek honours cancellation before and during either request and enforces the configured timeout', async (t) => {
  // AbortSignal.timeout uses an unref timer; keep the test alive while waiting.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  for (const tool of ['search', 'fetch'] as const) {
    const controller = new AbortController();
    let calls = 0;
    const provider = new DeepSeekProvider(
      config,
      undefined,
      async (_, options) => {
        calls++;
        controller.abort();
        assert.equal(options.signal.aborted, true);
        return resource(tool === 'search' ? { results: [] } : page);
      },
    );
    const execute = () =>
      tool === 'search'
        ? provider.webSearch(input, { abortSignal: controller.signal })
        : provider.webFetch(pageUrl, { abortSignal: controller.signal });
    await assert.rejects(execute(), { name: 'AbortError' });
    await assert.rejects(execute(), { name: 'AbortError' });
    assert.equal(calls, 1);
    const timed = new DeepSeekProvider(
      { ...config, timeoutMs: 5 },
      undefined,
      async (_, options) => {
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return resource(tool === 'search' ? { results: [] } : page);
      },
    );
    await assert.rejects(
      tool === 'search' ? timed.webSearch(input) : timed.webFetch(pageUrl),
      { name: 'TimeoutError' },
    );
  }
});

test('DeepSeek output works with existing tools, including empty searches, summaries and truncation', async () => {
  for (const results of [[], [searchResult]]) {
    const provider = new DeepSeekProvider(config, undefined, async () =>
      resource({ results }),
    );
    const tool = createWebSearchTool(
      { ...defaultWebSearchConfig, providerId: config.id },
      {
        resolveProvider: async () => provider,
        fallbackProvider: {
          id: 'local',
          webSearch: async () => assert.fail('Unexpected fallback'),
        },
      },
    );
    const output = await tool.execute!(
      { query: input.query },
      { observe: { span: async (_, fn) => fn(), log: () => {} } },
    );
    assert.deepEqual(output, {
      results: results.length ? [result] : [],
      provider: config.id,
      fallback: false,
    });
  }
  const provider = new DeepSeekProvider(config, undefined, async () =>
    resource({ ...page, content: 'a'.repeat(1001) }),
  );
  const tool = createWebFetchTool(
    { ...defaultWebFetchConfig, providerId: config.id, maxChars: 1000 },
    {
      resolveProvider: async () => provider,
      validateUrl: async () => ({ address: '93.184.216.34', family: 4 }),
    },
  );
  const output = await tool.execute!(
    { url: pageUrl },
    { observe: { span: async (_, fn) => fn(), log: () => {} } },
  );
  assert.ok(output && 'content' in output);
  assert.equal(output.content.length, 1000);
  assert.equal(output.truncated, true);
  assert.equal(output.provider, config.id);
  assert.equal(output.fallback, false);
});

test('provider factory selects DeepSeek while retaining model discovery and language model configuration', async () => {
  const builder = {
    addSelect() {
      return this;
    },
    where() {
      return this;
    },
    async getOne() {
      return { ...config, type: 'deepseek', enabled: true };
    },
  };
  const database = {
    getRepository: () => ({ createQueryBuilder: () => builder }),
  } as unknown as DataSource;
  const service = new ProviderService(database, async (url) => {
    assert.equal(url, `${config.baseUrl}/models`);
    return { data: [{ id: 'deepseek-v4-flash' }] };
  });
  const provider = await service.getProviderInstance(config.id);
  assert.ok(provider instanceof DeepSeekProvider);
  assert.deepEqual(await provider.getModelList(), [
    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
  ]);
  assert.deepEqual(provider.languageModel('deepseek-v4-flash'), {
    providerId: 'openai',
    modelId: 'deepseek-v4-flash',
    url: config.baseUrl,
    apiKey: config.apiKey,
    api: 'responses',
  });
  assert.equal(providerSupportsWebTool('deepseek', 'web_search'), true);
  assert.equal(providerSupportsWebTool('deepseek', 'web_fetch'), true);
  assert.equal(providerSupportsWebTool('serpapi', 'web_fetch'), false);
  assert.equal(providerSupportsWebTool('jina-ai', 'web_search'), false);
  assert.equal(providerSupportsWebTool('openai', 'web_search'), false);
});
