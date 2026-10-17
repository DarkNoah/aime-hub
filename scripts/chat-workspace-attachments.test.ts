import assert from 'node:assert/strict';
import test from 'node:test';
import type { UIMessage } from 'ai';
import {
  attachmentFileReference,
  serializeAttachments,
  splitMessageAttachments,
  workspaceAttachmentParts,
} from '@aime/shared/chat-attachments';
import { runInputSchema } from '@aime/shared/threads';
import { filesApi } from '../apps/web/src/components/file-manager/api.js';
import {
  readWorkspaceFileDrag,
  writeWorkspaceFileDrag,
} from '../apps/web/src/components/file-manager/drag-data.js';

const message = (parts: UIMessage['parts']): UIMessage => ({
  id: 'message01',
  role: 'user',
  parts,
});
const legacyHeader =
  'Referenced workspace files and folders (paths relative to the workspace):';

test('dragged workspace files and folders use the same escaped attachment format and display extraction as uploads', () => {
  const values = new Map<string, string>();
  const transfer = {
    effectAllowed: 'none',
    setData: (key: string, value: string) => values.set(key, value),
    getData: (key: string) => values.get(key) ?? '',
  };
  writeWorkspaceFileDrag(transfer as unknown as DataTransfer, 'workspace', {
    scope: 'thread',
    kind: 'file',
    path: '图 & "片".PNG',
  });
  const reference = readWorkspaceFileDrag(transfer, 'workspace');
  assert.ok(reference);
  const parts = workspaceAttachmentParts([
    reference,
    { scope: 'shared', kind: 'file', path: '报告.pdf' },
    { scope: 'shared', kind: 'directory', path: 'docs/nested' },
    { scope: 'thread', kind: 'directory', path: 'source' },
  ]);
  assert.ok(runInputSchema.safeParse({ id: 'message01', parts }).success);
  assert.match(
    parts[0].text,
    /^<attachment path="\.\/图 &amp; &quot;片&quot;\.PNG"/,
  );
  assert.doesNotMatch(
    parts[0].text,
    /Referenced workspace|<\/?attachments>|\b(?:id|name)="/,
  );
  const display = splitMessageAttachments(
    message([{ type: 'text', text: '检查这些文件' }, ...parts]),
  );
  assert.deepEqual(display.parts, [{ type: 'text', text: '检查这些文件' }]);
  assert.deepEqual(
    display.attachments.map(({ workspacePath, mediaType, filename }) => ({
      workspacePath,
      mediaType,
      filename,
    })),
    [
      {
        workspacePath: './图 & "片".PNG',
        mediaType: 'image/png',
        filename: '图 & "片".PNG',
      },
      {
        workspacePath: '../shared/报告.pdf',
        mediaType: 'application/pdf',
        filename: '报告.pdf',
      },
      {
        workspacePath: '../shared/docs/nested/',
        mediaType: 'inode/directory',
        filename: 'nested',
      },
      {
        workspacePath: './source/',
        mediaType: 'inode/directory',
        filename: 'source',
      },
    ],
  );
  assert.deepEqual(workspaceAttachmentParts([]), []);
});

test('workspace paths resolve to the correct scoped preview URLs and preserve folder targets', () => {
  for (const [path, scope, expected] of [
    ['./images/a.png', 'thread', 'images/a.png'],
    ['../shared/images/a.png', 'shared', 'images/a.png'],
    ['/.uploads/one/a.png', 'thread', '.uploads/one/a.png'],
    ['data/a.png', 'thread', 'data/a.png'],
  ] as const) {
    const target = attachmentFileReference(path);
    assert.deepEqual(target, { scope, path: expected, kind: 'file' });
    const url = new URL(
      filesApi.raw('thread', target!.path, false, target!.scope),
      'https://test.invalid',
    );
    assert.equal(url.searchParams.get('path'), expected);
    assert.equal(url.searchParams.get('scope') ?? 'thread', scope);
  }
  assert.deepEqual(attachmentFileReference('../shared/docs/'), {
    scope: 'shared',
    path: 'docs',
    kind: 'directory',
  });
});

test('legacy workspace references and upload XML render as attachments even after text parts are joined', () => {
  for (const metadata of [
    `${legacyHeader}\n- "./note.txt"\n- "../shared/clip.mp4"\n- "../shared/docs/"`,
    '<attachments>\n<attachment id="old" name="note.txt" path="./note.txt" mimeType="text/plain" />\n<attachment path="../shared/clip.mp4" mimeType="video/mp4" />\n<attachment path="../shared/docs/" mimeType="inode/directory" />\n</attachments>',
  ]) {
    const display = splitMessageAttachments(
      message([{ type: 'text', text: `正文\n${metadata}\n后续说明` }]),
    );
    assert.deepEqual(display.parts, [{ type: 'text', text: '正文\n后续说明' }]);
    assert.deepEqual(
      display.attachments.map((attachment) => attachment.workspacePath),
      ['./note.txt', '../shared/clip.mp4', '../shared/docs/'],
    );
    assert.equal(display.attachments[1].mediaType, 'video/mp4');
  }
});

test('path-only audio/video tags and uploads share the same attachment renderer input', () => {
  const display = splitMessageAttachments(
    message([
      {
        type: 'text',
        text:
          '<attachment path="./clip.mp4"></attachment>\n<attachment path="../shared/voice.wav"></attachment>\n' +
          serializeAttachments([
            { path: '/.uploads/image.png', mimeType: 'image/png' },
          ]),
      },
    ]),
  );
  assert.deepEqual(display.parts, []);
  assert.deepEqual(
    display.attachments.map((attachment) => attachment.mediaType),
    ['video/mp4', 'audio/wav', 'image/png'],
  );
});

test('traversal, malformed XML, fenced examples and assistant prose stay visible', () => {
  for (const path of [
    '../other/a.png',
    '../shared/../other/a.png',
    './a/../b',
    '//host/a',
    './a//b',
    './a/./b',
    'https://example.com/a',
    './a\\b',
    './a\u007f',
  ]) {
    assert.equal(attachmentFileReference(path), undefined, path);
    const original = message([
      {
        type: 'text',
        text: serializeAttachments([{ path, mimeType: 'image/png' }]),
      },
    ]);
    assert.deepEqual(splitMessageAttachments(original).parts, original.parts);
  }
  const xml = serializeAttachments([
    { path: './a.png', mimeType: 'image/png' },
  ]);
  for (const text of [
    `\`\`\`xml\n${xml}\n\`\`\``,
    `解释这个格式：${xml}`,
    xml.replace('</attachment>', ''),
    `<attachments>\n${xml}`,
    `<attachments>\n${xml}\ninvalid\n</attachments>`,
    `${legacyHeader}\n- "../other/secret"`,
  ]) {
    const original = message([{ type: 'text', text }]);
    assert.deepEqual(splitMessageAttachments(original), {
      parts: original.parts,
      attachments: [],
    });
  }
  const assistant = {
    ...message([{ type: 'text', text: xml }]),
    role: 'assistant' as const,
  };
  assert.deepEqual(splitMessageAttachments(assistant), {
    parts: assistant.parts,
    attachments: [],
  });
});
