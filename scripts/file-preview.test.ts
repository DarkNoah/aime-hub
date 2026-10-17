import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilePreview } from '@aime/shared/files';
import { previewFile } from '../apps/server/src/modules/files/service.js';
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
  for (const kind of [
    'image',
    'audio',
    'video',
    'pdf',
    'model',
    'binary',
  ] as const) {
    assert.equal(
      getPreviewKind(preview({ kind, mime: 'text/html', text: undefined })),
      kind,
    );
  }
});

test('PDF and GLB files use dedicated previews and MIME types instead of text sniffing', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'file-preview-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Uncompressed PDFs may consist entirely of readable ASCII.
  await writeFile(
    join(root, 'REPORT.PDF'),
    '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF',
  );
  await writeFile(
    join(root, 'scene.GLB'),
    Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]),
  );
  const pdf = await previewFile(root, 'REPORT.PDF');
  assert.equal(getPreviewKind(pdf), 'pdf');
  assert.equal(pdf.mime, 'application/pdf');
  assert.equal(pdf.text, undefined);
  const model = await previewFile(root, 'scene.GLB');
  assert.equal(getPreviewKind(model), 'model');
  assert.equal(model.mime, 'model/gltf-binary');
  assert.equal(model.text, undefined);
  await writeFile(join(root, 'notes.pdf.txt'), 'PDF notes');
  assert.equal(
    getPreviewKind(await previewFile(root, 'notes.pdf.txt')),
    'text',
  );
});
