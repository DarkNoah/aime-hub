import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWebFetchConfig } from '@aime/shared/tools';
import { createWebFetchTool } from '../apps/server/src/mastra/tools/web_fetch.js';
import { JinaAIProvider } from '../apps/server/src/mastra/providers/jina-ai.js';
import { BaseProvider } from '../apps/server/src/mastra/providers/base-provider.js';
import { LocalProvider } from '../apps/server/src/mastra/providers/local.js';
import {
  readBrowserPage,
  readWebPage,
  extractWebContent,
} from '../apps/server/src/mastra/web/page.js';
import {
  requestWebResource,
  webUrl,
  WebRequestError,
  type WebResource,
} from '../apps/server/src/mastra/web/request.js';

const url = 'https://example.com/news/article?q=one#section';
const result = { content: '# Article\n\nReadable content', url };
const config = { ...defaultWebFetchConfig, providerId: 'reader' };
const signal = () => new AbortController().signal;
const validateUrl = async () => ({ address: '93.184.216.34', family: 4 });
async function execute(
  tool: ReturnType<typeof createWebFetchTool>,
  target = url,
  abortSignal = signal(),
) {
  const output = await tool.execute!(
    { url: target },
    {
      abortSignal,
      observe: { span: async (_name, fn) => fn(), log: () => {} },
    },
  );
  assert.ok(output && 'content' in output);
  return output;
}

const resource = (
  body: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'text/html' },
): WebResource => ({ body: Buffer.from(body), status, headers, url });
const html = `<html><head><title>Article title</title></head><body><nav>Navigation</nav><article><h1>Article title</h1><p>${'This is the article content with enough text to be recognized. '.repeat(12)}</p><p><a href="../guide">Guide</a><img src="/image.png" alt="Diagram" /></p><script>secretScript()</script></article></body></html>`;

test('Jina uses the configured Reader endpoint, credential header and Markdown format without losing query or hash routes', async () => {
  const provider = new JinaAIProvider(
    {
      baseUrl: 'https://reader.example/api',
      apiKey: 'synthetic-key',
      timeoutMs: 1000,
    },
    async (target, options) => {
      assert.equal(target, 'https://reader.example/api');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(String(options.body)), { url });
      assert.equal(options.headers?.authorization, 'Bearer synthetic-key');
      assert.equal(options.headers?.['x-with-generated-alt'], 'true');
      assert.equal(options.headers?.['x-respond-with'], 'markdown');
      assert.ok(options.signal);
      return resource(result.content);
    },
  );
  assert.ok(provider instanceof BaseProvider);
  assert.equal((await provider.webFetch(url)).content, result.content);
});

test('Jina rejects errors, redirects and empty content without returning upstream secrets', async () => {
  for (const response of [
    resource('synthetic-key', 401),
    resource('redirect', 302),
    resource(' '),
  ]) {
    const provider = new JinaAIProvider(
      {
        baseUrl: 'https://r.jina.ai',
        apiKey: 'synthetic-key',
        timeoutMs: 1000,
      },
      async () => response,
    );
    await assert.rejects(provider.webFetch(url), (error) => {
      assert.doesNotMatch(String(error), /synthetic-key/);
      return true;
    });
  }
  let calls = 0;
  const invalid = new JinaAIProvider(
    { baseUrl: 'http://r.jina.ai', apiKey: 'key', timeoutMs: 1000 },
    async () => {
      calls++;
      return resource('data');
    },
  );
  await assert.rejects(invalid.webFetch(url));
  assert.equal(calls, 0);
});

test('Defuddle extracts Markdown with absolute image and source URLs', async () => {
  const parsed = await extractWebContent(html, url);
  assert.match(parsed.content, /^# Article title/);
  assert.match(parsed.content, /\[Guide\]\(https:\/\/example.com\/guide\)/);
  assert.match(
    parsed.content,
    /!\[Diagram\]\(https:\/\/example.com\/image.png\)/,
  );
  assert.doesNotMatch(parsed.content, /secretScript|<script>/);
  assert.equal(parsed.url, url);
  await assert.rejects(() =>
    extractWebContent('<html><body><div id="root"></div></body></html>', url),
  );
});

test('direct fetch follows bounded redirects and resolves relative content against the final page URL', async () => {
  const calls: string[] = [];
  const fetched = await readWebPage(
    url,
    { signal: signal() },
    async (target) => {
      calls.push(target);
      return calls.length === 1
        ? resource('', 302, {
            location: 'https://destination.example/blog/post',
          })
        : resource(html);
    },
  );
  assert.equal(fetched.url, 'https://destination.example/blog/post');
  assert.match(fetched.content, /https:\/\/destination.example\/guide/);
  assert.equal(calls.length, 2);
  let redirects = 0;
  await assert.rejects(
    readWebPage(url, { signal: signal() }, async () => {
      redirects++;
      return resource('', 302, { location: '/loop' });
    }),
  );
  assert.equal(redirects, 6);
  assert.equal(
    (
      await readWebPage(url, { signal: signal() }, async () =>
        resource('plain text', 200, { 'content-type': 'text/plain' }),
      )
    ).content,
    'plain text',
  );
});

test('Defuddle preserves code and tables without making its own network requests', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new Error('Unexpected extraction request');
  });
  const rich = html.replace(
    '</article>',
    `<pre><code class="language-js">const value = 42;</code></pre><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Example</td><td>42</td></tr></tbody></table></article>`,
  );
  const parsed = await extractWebContent(rich, url);
  assert.match(parsed.content, /```(?:js|javascript)\nconst value = 42;/);
  assert.match(parsed.content, /\| Name \| Value \|/);
  assert.equal(requests, 0);
});

test('LocalProvider implements both search and fetch through BaseProvider', async () => {
  const provider = new LocalProvider({
    timeoutMs: 1000,
    fetchPage: async () =>
      new Response(
        '<div class="vrwrap"><h3><a href="https://example.com/news">News</a></h3><div>Summary</div></div>',
      ),
    readDirect: async () => result,
  });
  assert.ok(provider instanceof BaseProvider);
  assert.equal(provider.id, 'local');
  assert.deepEqual(await provider.webSearch({ query: 'news', numResults: 1 }), [
    { title: 'News', href: 'https://example.com/news', snippet: 'Summary' },
  ]);
  assert.deepEqual(await provider.webFetch(url), result);
  assert.deepEqual(await provider.getLanguageModelList(), []);
});

test('local fallback uses the browser only after direct request or extraction fails', async () => {
  let browsers = 0;
  const readBrowser = async () => {
    browsers++;
    return result;
  };
  const direct = new LocalProvider({
    timeoutMs: 1000,
    readDirect: async () => result,
    readBrowser,
  });
  assert.deepEqual(await direct.webFetch(url), result);
  assert.equal(browsers, 0);
  const fallback = new LocalProvider({
    timeoutMs: 1000,
    readDirect: async () => {
      throw new Error('No article');
    },
    readBrowser,
  });
  assert.deepEqual(await fallback.webFetch(url), result);
  assert.equal(browsers, 1);
  const blocked = new LocalProvider({
    timeoutMs: 1000,
    readDirect: async () => {
      throw new WebRequestError('INVALID_URL');
    },
    readBrowser,
  });
  await assert.rejects(blocked.webFetch(url));
  assert.equal(browsers, 1);
});

test('web_fetch prefers the provider, falls back on missing/failed/empty providers and marks truncation', async () => {
  let fallbackCalls = 0;
  const fallbackProvider = {
    id: 'local',
    webFetch: async () => {
      fallbackCalls++;
      return result;
    },
  };
  const dependencies = { validateUrl, fallbackProvider };
  const success = createWebFetchTool(
    { ...config, maxChars: 1000 },
    {
      ...dependencies,
      resolveProvider: async () => ({
        id: 'jina-ai',
        webFetch: async () => ({ ...result, content: 'a'.repeat(1200) }),
      }),
    },
  );
  const fetched = await execute(success);
  assert.equal(fetched.provider, 'jina-ai');
  assert.equal(fetched.content.length, 1000);
  assert.equal(fetched.truncated, true);
  assert.equal(fetched.fallback, false);
  assert.equal(fallbackCalls, 0);
  for (const resolveProvider of [
    async () => {
      throw new Error('provider deleted');
    },
    async () => ({
      id: 'jina-ai',
      webFetch: async () => {
        throw new Error('synthetic-key');
      },
    }),
    async () => ({
      id: 'jina-ai',
      webFetch: async () => ({ ...result, content: '' }),
    }),
  ]) {
    const tool = createWebFetchTool(config, {
      ...dependencies,
      resolveProvider,
    });
    const output = await execute(tool);
    assert.equal(output.provider, 'local');
    assert.equal(output.fallback, true);
    assert.equal(output.ok, true);
  }
  assert.equal(fallbackCalls, 3);
});

test('cancellation stops provider resolution, provider execution and direct fallback without launching the next stage', async () => {
  for (const stage of ['before', 'resolve', 'provider']) {
    const controller = new AbortController();
    let fallbacks = 0;
    if (stage === 'before') controller.abort();
    const tool = createWebFetchTool(config, {
      validateUrl,
      resolveProvider: async () => {
        if (stage === 'resolve') controller.abort();
        return {
          id: 'jina-ai',
          webFetch: async () => {
            controller.abort();
            return result;
          },
        };
      },
      fallbackProvider: {
        id: 'local',
        webFetch: async () => {
          fallbacks++;
          return result;
        },
      },
    });
    const output = await execute(tool, url, controller.signal);
    assert.equal(output.isError, true);
    assert.match(output.content, /cancelled/);
    assert.equal(fallbacks, 0);
  }
  const controller = new AbortController();
  const local = new LocalProvider({
    timeoutMs: 1000,
    readDirect: async () => {
      controller.abort();
      throw new Error('aborted');
    },
    readBrowser: async () => {
      assert.fail('browser must not launch');
    },
  });
  await assert.rejects(local.webFetch(url, { abortSignal: controller.signal }));
});

test('private URLs and invalid protocols are rejected before any provider call, and failures redact upstream errors', async () => {
  for (const target of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com',
  ])
    assert.throws(() => webUrl(target));
  for (const target of [
    'http://127.0.0.1',
    'http://169.254.169.254',
    'http://[::1]',
  ]) {
    await assert.rejects(
      requestWebResource(target, { signal: AbortSignal.timeout(1000) }),
      { code: 'INVALID_URL' },
    );
  }
  const tool = createWebFetchTool(config, {
    validateUrl: async () => {
      throw new WebRequestError('INVALID_URL');
    },
    resolveProvider: async () => {
      assert.fail('blocked destination must not reach Jina');
    },
  });
  assert.equal((await execute(tool, 'http://127.0.0.1')).isError, true);
  const failed = createWebFetchTool(config, {
    validateUrl,
    fallbackProvider: {
      id: 'local',
      webFetch: async () => {
        throw new Error('Bearer synthetic-secret');
      },
    },
  });
  const output = await execute(failed);
  assert.equal(output.ok, false);
  assert.equal(output.isError, true);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret/);
});

test(
  'browser fallback renders JavaScript in an isolated browser and converts the resulting article',
  { skip: process.env.TEST_WEB_FETCH_BROWSER !== '1' },
  async () => {
    const rendered = `<html><head><title>Rendered article</title></head><body><div id="root"></div><script>setTimeout(() => document.querySelector('#root').innerHTML = ${JSON.stringify(html).replaceAll('<', '\\u003c')}, 20)</script></body></html>`;
    const requests: string[] = [];
    const output = await readBrowserPage(
      url,
      AbortSignal.timeout(15000),
      15000,
      async (target) => {
        requests.push(target);
        return resource(rendered);
      },
    );
    assert.match(output.content, /article content/);
    assert.match(output.content, /https:\/\/example.com\/guide/);
    assert.ok(requests.includes(url.split('#')[0]));
  },
);

test(
  'browser fallback applies stealth before scripts and forwards identity without credentials or shared storage',
  { skip: process.env.TEST_WEB_FETCH_BROWSER !== '1', timeout: 30000 },
  async () => {
    const rendered = `<html><head><title>Stealth article</title></head><body><article><h1>Stealth article</h1><p>${'Browser identity and storage isolation. '.repeat(12)}</p></article><script>
      const identity = {
        webdriver: navigator.webdriver === true,
        userAgent: navigator.userAgent,
        language: navigator.language,
        cookie: document.cookie,
        stored: localStorage.getItem('reader-test')
      };
      document.cookie = 'reader_cookie=private; path=/';
      localStorage.setItem('reader-test', 'private');
      fetch('/probe?identity=' + encodeURIComponent(JSON.stringify(identity)), {
        headers: { authorization: 'Bearer fixture-secret', 'x-private': 'fixture-secret' }
      });
      fetch('/blocked-write', { method: 'POST', body: 'private' }).catch(() => {});
    </script></body></html>`;
    for (let run = 0; run < 2; run++) {
      const requests: { url: string; headers: Record<string, string> }[] = [];
      await readBrowserPage(
        url,
        AbortSignal.timeout(15000),
        15000,
        async (target, options) => {
          requests.push({ url: target, headers: options.headers ?? {} });
          return new URL(target).pathname === '/probe'
            ? resource('ok', 200, { 'content-type': 'text/plain' })
            : resource(rendered, 200, {
                'content-type': 'text/html',
                'set-cookie': 'server_cookie=private; Path=/',
              });
        },
      );
      const probe = requests.find(
        (entry) => new URL(entry.url).pathname === '/probe',
      );
      assert.ok(probe);
      const identity = JSON.parse(
        new URL(probe.url).searchParams.get('identity')!,
      );
      assert.equal(identity.webdriver, false);
      assert.doesNotMatch(identity.userAgent, /HeadlessChrome/);
      assert.equal(identity.cookie, '');
      assert.equal(identity.stored, null);
      for (const entry of requests) {
        assert.equal(entry.headers['user-agent'], identity.userAgent);
        assert.ok(
          entry.headers['accept-language']?.startsWith(identity.language),
        );
        assert.ok(entry.headers['sec-ch-ua']);
        assert.equal(entry.headers.cookie, undefined);
        assert.equal(entry.headers.authorization, undefined);
        assert.equal(entry.headers['x-private'], undefined);
      }
      assert.equal(
        requests.some((entry) => entry.url.includes('/blocked-write')),
        false,
      );
    }
  },
);
