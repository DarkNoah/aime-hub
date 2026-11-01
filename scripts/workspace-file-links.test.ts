import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getWorkspaceFilePath,
  getWorkspaceFileTarget,
  isWorkspaceDirectoryLink,
  rehypeWorkspaceFileLinks,
  toWorkspaceFileLink,
} from '../apps/web/src/components/ai-elements/markdown-file-link.js';
for (const [href, expected] of [
  ['./notes/readme.md', 'notes/readme.md'],
  ['notes/../readme.md', 'readme.md'],
  ['../shared/hello.json', '../shared/hello.json'],
  ['./../shared/nested/../hello.json', '../shared/hello.json'],
  ['../shared/', '../shared'],
  ['..%2Fshared%2Fhello%20world.txt', '../shared/hello world.txt'],
  ['shared/hello.json', 'shared/hello.json'],
  [
    '/workspaces/users/alice/shared/hello.json',
    '/workspaces/users/alice/shared/hello.json',
  ],
  ['/tmp/writefile-escape-test.txt', '/tmp/writefile-escape-test.txt'],
] as const) {
  test(`workspace Markdown link survives rewriting: ${href}`, () => {
    assert.equal(getWorkspaceFilePath(href), expected);
    const node = { type: 'element', tagName: 'a', properties: { href } };
    rehypeWorkspaceFileLinks()(node);
    assert.equal(
      node.properties.href,
      toWorkspaceFileLink(expected, href.endsWith('/')),
    );
    assert.equal(getWorkspaceFilePath(node.properties.href), expected);
    assert.equal(
      isWorkspaceDirectoryLink(node.properties.href),
      href.endsWith('/'),
    );
  });
}

for (const [href, path, line] of [
  ['/abs/path/app.py:12', '/abs/path/app.py', 12],
  [
    '/abs/path/My Project/My Report.md:3',
    '/abs/path/My Project/My Report.md',
    3,
  ],
  [
    '/abs/path/My%20Project/My%20Report.md%3A3',
    '/abs/path/My Project/My Report.md',
    3,
  ],
  ['./src/app.ts:1', 'src/app.ts', 1],
  ['../shared/hello.json:32', '../shared/hello.json', 32],
  ['/工作区/说明.md:8', '/工作区/说明.md', 8],
] as const) {
  test(`workspace file line survives rewriting without becoming part of the path: ${href}`, () => {
    assert.deepEqual(getWorkspaceFileTarget(href), { path, line });
    assert.equal(getWorkspaceFilePath(href), path);
    const node = { type: 'element', tagName: 'a', properties: { href } };
    rehypeWorkspaceFileLinks()(node);
    assert.equal(node.properties.href, toWorkspaceFileLink(path, false, line));
    assert.deepEqual(getWorkspaceFileTarget(node.properties.href), {
      path,
      line,
    });
    assert.equal(isWorkspaceDirectoryLink(node.properties.href), false);
    rehypeWorkspaceFileLinks()(node);
    assert.deepEqual(getWorkspaceFileTarget(node.properties.href), {
      path,
      line,
    });
  });
}

test('workspace links reject schemes, protocol-relative URLs and unrecognized parent traversal', () => {
  for (const href of [
    'https://example.com',
    '//example.com/file',
    '%2F%2Fexample.com/file',
    'javascript:alert(1)',
    'file:///tmp/file',
    '../private/file',
    '../../bob/shared/file',
    '../shared/../private/file',
    '../shared/%2E%2E/private/file',
    '/%00file',
    '%ZZ',
    'file.txt?download=1',
    'file.txt#section',
    '/tmp/file:stream',
    '/tmp/file:0',
    '/tmp/file:-1',
    '/tmp/file:1.5',
    '/tmp/file:12-20',
    '/tmp/file:9007199254740992',
    '/tmp/folder/:12',
    '//example.com/file:12',
    '/%00file:12',
    'javascript:12',
    '../shared/../private/file:12',
  ]) {
    assert.equal(getWorkspaceFilePath(href), undefined, href);
  }
});
