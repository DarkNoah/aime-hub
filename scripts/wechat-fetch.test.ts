import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractWebContent,
  readBrowserPage,
  readWebPage,
} from '../apps/server/src/mastra/web/page.js';
import { readArticleContent } from '../apps/server/src/mastra/web/article.js';
import {
  assertWechatResult,
  WechatArticleError,
} from '../apps/server/src/mastra/web/wechat.js';
import { createWebFetchTool } from '../apps/server/src/mastra/tools/web_fetch.js';
import { defaultWebFetchConfig } from '@aime/shared/tools';

const url = 'https://mp.weixin.qq.com/s/example';
const text =
  '这是文章的实际正文，介绍技术实现、数据验证和后续应用，正文应当完整保留。';
const html = `<html><head><title>页面</title></head><body><h1 id="activity-name">测试文章</h1><div id="js_content" style="visibility:hidden;opacity:0"><p>${text}</p><img data-src="https://example.com/image.jpg" src="data:image/gif;base64,R0lGOD"/><pre><code>const first = 1;</code><code>const second = 2;</code></pre><a href="javascript:alert(1)">安全链接</a><script>throw new Error('must not execute')</script></div><footer>赞 在看 小程序</footer></body></html>`;
const resource = (body: string) => ({
  url,
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(body),
});

test('WeChat extraction preserves Chinese body, lazy images, multiline code and excludes page chrome', async () => {
  const result = await extractWebContent(html, url);
  assert.match(result.content, /^# 测试文章/);
  assert.ok(result.content.includes(text));
  assert.match(result.content, /https:\/\/example.com\/image.jpg/);
  assert.match(result.content, /const first = 1;\nconst second = 2;/);
  assert.doesNotMatch(
    result.content,
    /小程序|javascript:|must not execute|data:image/,
  );
});
test('WeChat verification redirects, deleted articles and empty shells never become successful content', async () => {
  await assert.rejects(
    readWebPage(url, { signal: AbortSignal.timeout(1000) }, async () => ({
      ...resource('chrome'),
      status: 302,
      headers: {
        location:
          'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?target_url=example',
      },
    })),
    { code: 'WECHAT_VERIFICATION_REQUIRED' },
  );
  for (const [body, code] of [
    ['环境异常，完成验证后即可继续访问', 'WECHAT_VERIFICATION_REQUIRED'],
    ['该内容已被发布者删除', 'WECHAT_ARTICLE_UNAVAILABLE'],
    [
      '视频 小程序 赞 ，轻点两下取消赞 在看 ，轻点两下取消在看',
      'WECHAT_CONTENT_MISSING',
    ],
  ]) {
    await assert.rejects(
      extractWebContent(`<html><body>${body}</body></html>`, url),
      { code },
    );
  }
  assert.throws(
    () =>
      assertWechatResult(url, {
        url,
        content:
          '# Weixin Official Accounts Platform\n\n: ，. Video Mini Program Like ，轻点两下取消赞 Wow ，轻点两下取消在看',
      }),
    { code: 'WECHAT_CONTENT_MISSING' },
  );
});
test('JsDecode literals are recovered without evaluating scripts or accepting expression payloads', async () => {
  const encoded = `<html><body><script>const article = { title: JsDecode('内嵌文章'), content: JsDecode('\\x26lt;p\\x26gt;${text}\\x26lt;/p\\x26gt;') }; throw new Error('do not execute');</script></body></html>`;
  assert.ok((await extractWebContent(encoded, url)).content.includes(text));
  await assert.rejects(
    extractWebContent(
      `<html><script>content: JsDecode('hello' + malicious())</script></html>`,
      url,
    ),
  );
});
test('article reader prioritizes the browser and keeps content beyond the Agent tool limit', async () => {
  const body = '# 长文章\n\n' + text.repeat(2000) + '\n\n完整正文结束';
  let direct = 0;
  const result = await readArticleContent(url, AbortSignal.timeout(5000), {
    browser: async () => ({ url, content: body }),
    direct: async () => {
      direct++;
      throw new Error('not needed');
    },
  });
  assert.equal(result.content, body);
  assert.equal(result.provider, 'playwright');
  assert.equal(direct, 0);
  assert.ok(result.content.length > 50_000);
  const failed = createWebFetchTool(defaultWebFetchConfig, {
    validateUrl: async () => ({ address: '1.1.1.1', family: 4 }),
    fallbackProvider: {
      id: 'local',
      webFetch: async () => {
        throw new WechatArticleError('WECHAT_VERIFICATION_REQUIRED');
      },
    },
  });
  const output = await failed.execute!(
    { url },
    {
      abortSignal: AbortSignal.timeout(5000),
      observe: { span: async (_name, fn) => fn(), log: () => {} },
    },
  );
  assert.ok(output && 'ok' in output && !output.ok);
  assert.equal(output.errorCode, 'WECHAT_VERIFICATION_REQUIRED');
});
test(
  'Playwright waits for dynamically populated WeChat content and archives the complete rendered body',
  { skip: process.env.TEST_WEB_FETCH_BROWSER !== '1', timeout: 20000 },
  async () => {
    const full = `<div id="js_content"><p>${text.repeat(1600)}</p><p>最终完整段落</p></div>`;
    const dynamic = `<html><head><title>动态文章</title><meta property="og:title" content="动态文章"/></head><body><div id="root"></div><script>setTimeout(() => document.querySelector('#root').innerHTML = ${JSON.stringify(full).replaceAll('<', '\\u003c')}, 1000)</script></body></html>`;
    const output = await readArticleContent(url, AbortSignal.timeout(15000), {
      browser: (target, signal, timeout) =>
        readBrowserPage(target, signal, timeout, async () => resource(dynamic)),
      direct: async () => {
        throw new Error('Browser should succeed');
      },
    });
    assert.ok(output.content.length > 50_000);
    assert.equal(output.content.slice(-6), '最终完整段落');
    assert.equal(output.provider, 'playwright');
  },
);

test('article reader rejects generic verification pages and aborts a queued WeChat request before dispatch', async () => {
  const challenge = async () => ({
    url: 'https://example.org/verify',
    content: '# Security Verification\n\nPlease verify you are human.',
  });
  await assert.rejects(
    readArticleContent(
      'https://example.org/article',
      AbortSignal.timeout(2000),
      { browser: challenge, direct: challenge },
    ),
    /ARTICLE_VERIFICATION_REQUIRED/,
  );
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queuedCalls = 0;
  const first = readArticleContent(url, AbortSignal.timeout(2000), {
    browser: async () => {
      await waiting;
      return { url, content: text };
    },
  });
  const abort = new AbortController();
  const second = readArticleContent(url, abort.signal, {
    browser: async () => {
      queuedCalls++;
      return { url, content: text };
    },
  });
  abort.abort();
  try {
    await assert.rejects(second, { name: 'AbortError' });
  } finally {
    release();
    await first;
  }
  assert.equal(queuedCalls, 0);
});
