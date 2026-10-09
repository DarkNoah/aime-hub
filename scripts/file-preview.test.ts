import assert from 'node:assert/strict';
import test from 'node:test';
import type { FilePreview } from '@aime/shared/files';
import { getPreviewKind } from '../apps/web/src/components/file-manager/preview/preview-kind.js';

function preview(overrides: Partial<FilePreview> = {}): FilePreview {
  return {
    path: 'index.html',
    kind: 'text',
    mime: 'text/plain; charset=utf-8',
    text: '<h1>Hello</h1>',
    size: 14,
    modifiedAt: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

test('HTML preview accepts HTML and HTM extensions case-insensitively and HTML MIME types', () => {
  for (const path of [
    'index.html',
    'nested/page.htm',
    'nested/PAGE.HTML',
    'PAGE.HTM',
  ]) {
    assert.equal(getPreviewKind(preview({ path })), 'html');
  }
  assert.equal(
    getPreviewKind(preview({ path: 'page', mime: 'text/html; charset=utf-8' })),
    'html',
  );
  assert.equal(
    getPreviewKind(preview({ path: 'page', mime: 'Text/HTML' })),
    'html',
  );
});

test('ordinary text stays in the source viewer even when its contents or directory look like HTML', () => {
  for (const path of [
    'index.html.txt',
    'page.md',
    'src/component.tsx',
    'html/plain',
    'page.html/plain',
    'html',
    'htm',
  ]) {
    assert.equal(getPreviewKind(preview({ path })), 'text');
  }
});

test('server media and binary classification takes precedence over the HTML filename or MIME', () => {
  for (const kind of ['image', 'audio', 'video', 'binary'] as const) {
    assert.equal(
      getPreviewKind(preview({ kind, mime: 'text/html', text: undefined })),
      kind,
    );
  }
});
