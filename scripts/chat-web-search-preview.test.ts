import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWebSearchOutput,
  webSearchLink,
} from '../apps/web/src/components/chat/message-preview/web-search-output.js';

test('web search preserves result order and text for structured and serialized outputs', () => {
  const output = {
    results: [
      {
        title: '文档',
        href: 'https://example.com/docs',
        snippet: '第一行\n第二行',
      },
      { title: '', href: 'https://example.com/other' },
    ],
    provider: 'sogou',
    fallback: true,
  };
  const before = structuredClone(output);
  for (const value of [output, JSON.stringify(output)]) {
    const parsed = parseWebSearchOutput(value);
    assert.equal(parsed?.provider, 'sogou');
    assert.equal(parsed?.fallback, true);
    assert.equal(parsed?.isError, false);
    assert.equal(parsed?.results[0].snippet, '第一行\n第二行');
    assert.equal(parsed?.results[1].title, '');
    assert.equal(parsed?.results[1].snippet, undefined);
    assert.equal(parsed?.results.length, 2);
  }
  assert.deepEqual(output, before);
});

test('web search distinguishes empty success from tool-reported failure and cancellation', () => {
  assert.equal(parseWebSearchOutput({ results: [] })?.isError, false);
  for (const message of [
    'Web search failed.',
    'Web search was cancelled.',
    '',
  ]) {
    const parsed = parseWebSearchOutput({
      results: [],
      provider: 'none',
      fallback: false,
      isError: true,
      message,
    });
    assert.equal(parsed?.isError, true);
    assert.equal(parsed?.message, message);
    assert.deepEqual(parsed?.results, []);
  }
});

test('unrecognized web search outputs fall back to raw rendering without dropping malformed rows', () => {
  for (const value of [
    undefined,
    null,
    false,
    0,
    '',
    'not JSON',
    'null',
    [],
    {},
    { results: 'invalid' },
    { results: [], isError: 'true' },
    { results: [], fallback: 'false' },
    { results: [], provider: {} },
    { results: [], message: [] },
    { results: [{ title: 'Valid', href: 'https://example.com' }, null] },
    { results: [{ title: 12, href: 'https://example.com' }] },
    { results: [{ title: 'Title', href: null }] },
    { results: [{ title: 'Title', href: 'https://example.com', snippet: {} }] },
  ])
    assert.equal(parseWebSearchOutput(value), null);
});

test('search results only link to absolute HTTP URLs without credentials', () => {
  assert.deepEqual(webSearchLink('https://example.com/path?q=中文#part'), {
    href: 'https://example.com/path?q=%E4%B8%AD%E6%96%87#part',
    hostname: 'example.com',
  });
  assert.equal(
    webSearchLink('http://example.com')?.href,
    'http://example.com/',
  );
  for (const value of [
    '',
    '/relative',
    '//example.com',
    'invalid',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'mailto:someone@example.com',
    'https://user:secret@example.com/',
    'https://user@example.com/',
  ])
    assert.equal(webSearchLink(value), null);
});
