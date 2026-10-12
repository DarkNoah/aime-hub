import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebFetchOutput } from '../apps/web/src/components/chat/message-preview/web-fetch-output.js';
import { webPreviewLink } from '../apps/web/src/components/chat/message-preview/web-link.js';

test('web fetch preserves Markdown and metadata from structured and serialized results', () => {
  const value = {
    content:
      '# 页面\n\n[参考](https://example.com)\n\n```ts\nconst answer = 42;\n```',
    url: 'https://example.com/article',
    title: '页面',
    contentType: 'text/markdown',
    provider: 'local',
    fallback: true,
    truncated: true,
    ok: true,
  };
  const before = structuredClone(value);
  for (const output of [value, JSON.stringify(value)]) {
    assert.deepEqual(parseWebFetchOutput(output), {
      content: value.content,
      url: value.url,
      title: value.title,
      contentType: value.contentType,
      provider: value.provider,
      fallback: true,
      truncated: true,
      isError: false,
    });
  }
  assert.deepEqual(value, before);
});

test('web fetch supports legacy text and distinguishes empty content from errors', () => {
  const text = '# Legacy page\n\nBody text';
  assert.equal(parseWebFetchOutput(text)?.content, text);
  for (const output of ['', { content: '' }, { content: ' ', ok: true }]) {
    const result = parseWebFetchOutput(output);
    assert.equal(result?.content.trim(), '');
    assert.equal(result?.isError, false);
  }
  for (const flags of [
    { ok: false },
    { isError: true },
    { ok: true, isError: true },
  ]) {
    const result = parseWebFetchOutput({
      content: 'Web fetch was cancelled.',
      ...flags,
    });
    assert.equal(result?.isError, true);
    assert.equal(result?.content, 'Web fetch was cancelled.');
  }
});

test('web fetch keeps plain text and JSON bodies intact and rejects malformed envelopes', () => {
  for (const contentType of ['text/plain', 'application/json']) {
    const content = '{"content":"not a nested result"}\n';
    assert.equal(
      parseWebFetchOutput({ content, contentType })?.content,
      content,
    );
  }
  for (const output of [
    undefined,
    null,
    false,
    1,
    [],
    {},
    { content: null },
    { content: [] },
    { content: 'text', url: 1 },
    { content: 'text', title: {} },
    { content: 'text', contentType: [] },
    { content: 'text', provider: false },
    { content: 'text', fallback: 'false' },
    { content: 'text', truncated: 'true' },
    { content: 'text', ok: 'false' },
    { content: 'text', isError: 'true' },
    JSON.stringify({ content: 'text', ok: 'false' }),
  ])
    assert.equal(parseWebFetchOutput(output), null);
});

test('web preview source links reject scripts, relative paths and embedded credentials', () => {
  assert.deepEqual(webPreviewLink('https://example.com/page?q=文档#details'), {
    href: 'https://example.com/page?q=%E6%96%87%E6%A1%A3#details',
    hostname: 'example.com',
  });
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/test',
    '/api/private',
    '//example.com',
    'https://user:secret@example.com',
    'invalid',
  ]) {
    assert.equal(webPreviewLink(value), null);
  }
});
