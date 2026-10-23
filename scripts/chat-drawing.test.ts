import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  MAX_CHAT_FILES,
  MAX_IMAGE_BYTES,
  runInputSchema,
} from '@aime/shared/threads';
import {
  ChatUploadQueue,
  chatUploadParts,
  type ChatUploadDependencies,
  type ChatUpload,
} from '../apps/web/src/components/chat/chat-uploads.js';
import {
  consumeDrawCommand,
  filterCommandGroups,
} from '../apps/web/src/components/chat/slash-command.js';
import { splitMessageAttachments } from '../apps/web/src/components/chat/message-attachments.js';

function setup(image?: ChatUploadDependencies['image']) {
  const calls: string[] = [];
  const queue = new ChatUploadQueue({
    ensureThread: async () => {
      calls.push('thread');
      return 'test-thread';
    },
    prepare: async () => {
      calls.push('prepare');
    },
    upload: async (_thread, directory, file) => {
      calls.push('upload');
      return { path: `${directory}/${file.name}` };
    },
    remove: async () => {
      calls.push('remove');
    },
    image: image ?? (async () => 'data:image/png;base64,aGVsbG8='),
    onError: (error) => {
      calls.push((error as { code?: string }).code ?? 'error');
    },
    onUploaded: () => {
      calls.push('uploaded');
    },
  });
  return { queue, calls };
}
const drawing = () => new File(['hello'], 'drawing.png', { type: 'image/png' });

test('edited images upload, keep their canvas, and send only a workspace reference', async () => {
  const { queue, calls } = setup(async () => {
    throw new Error('Edited images must not become inline base64');
  });
  const snapshot: NonNullable<ChatUpload['drawing']> = {
    document: { store: {}, schema: { schemaVersion: 2, sequences: {} } },
  };
  assert.equal(queue.add([drawing()], 0, snapshot), true);
  await setImmediate();
  const first = queue.getSnapshot()[0];
  assert.equal(first.status, 'done');
  assert.equal(first.drawing, snapshot);
  assert.equal(first.inlineOnly, undefined);
  assert.equal(first.image, undefined);
  assert.match(first.path!, /^\.uploads\//);
  assert.deepEqual(calls, ['thread', 'prepare', 'upload', 'uploaded']);
  const parts = chatUploadParts(queue.getSnapshot());
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'text');
  assert.ok(parts[0].type === 'text' && parts[0].text.includes(first.path!));
  assert.ok(runInputSchema.safeParse({ id: 'edited-image', parts }).success);
  const displayed = splitMessageAttachments({
    id: 'edited-image',
    role: 'user',
    parts,
  });
  assert.equal(displayed.attachments.length, 1);
  assert.ok(displayed.attachments[0].workspacePath);
  assert.equal(
    queue.replaceDrawing(first.id, drawing(), structuredClone(snapshot)),
    true,
  );
  await setImmediate();
  const second = queue.getSnapshot()[0];
  assert.equal(queue.getSnapshot().length, 1);
  assert.equal(second.id, first.id);
  assert.notEqual(second.path, first.path);
  assert.equal(second.image, undefined);
  assert.equal(calls.filter((value) => value === 'remove').length, 1);
  queue.cancel(second.id);
  await setImmediate();
  assert.equal(calls.filter((value) => value === 'remove').length, 2);
});

test('edited uploads can exceed the inline image limit and retain a preview', async () => {
  const { queue } = setup(async () => {
    throw new Error('No inline conversion expected');
  });
  const snapshot: NonNullable<ChatUpload['drawing']> = {
    document: { store: {}, schema: { schemaVersion: 2, sequences: {} } },
  };
  assert.equal(
    queue.add(
      [
        new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'edited.png', {
          type: 'image/png',
        }),
      ],
      0,
      snapshot,
    ),
    true,
  );
  await setImmediate();
  assert.equal(queue.getSnapshot()[0].status, 'done');
  assert.match(queue.getSnapshot()[0].preview, /^blob:/);
  assert.equal(
    chatUploadParts(queue.getSnapshot()).some((part) => part.type === 'file'),
    false,
  );
  queue.commit();
});

test('editing replaces the same attachment and keeps the canvas out of message parts', async () => {
  const { queue, calls } = setup();
  const first: NonNullable<ChatUpload['drawing']> = {
    document: { store: {}, schema: { schemaVersion: 2, sequences: {} } },
  };
  const second = structuredClone(first);
  queue.addInlineImage(drawing(), 0, first);
  await setImmediate();
  const original = queue.getSnapshot()[0];
  assert.equal(original.drawing, first);
  assert.equal(queue.replaceDrawing(original.id, drawing(), second), true);
  await setImmediate();
  const updated = queue.getSnapshot();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, original.id);
  assert.notEqual(updated[0].preview, original.preview);
  assert.equal(updated[0].drawing, second);
  assert.equal('drawing' in chatUploadParts(updated)[0], false);
  assert.equal('path' in chatUploadParts(updated)[0], false);
  assert.equal(queue.replaceDrawing('missing', drawing(), second), false);
  assert.deepEqual(calls, []);
  queue.commit();
});

test('draw command consumes only its token and is searchable by Chinese description', () => {
  assert.equal(consumeDrawCommand('/DRAW\n保留草稿'), '保留草稿');
  assert.equal(consumeDrawCommand('/draw'), '');
  assert.equal(consumeDrawCommand('/drawing'), null);
  assert.equal(consumeDrawCommand('普通 /draw'), null);
  const groups = [
    {
      id: 'builtin',
      sections: [
        {
          id: 'builtin',
          items: [
            {
              id: 'draw',
              name: 'draw',
              description: '打开绘画板',
              action: 'draw' as const,
            },
          ],
        },
      ],
    },
  ];
  assert.equal(
    filterCommandGroups(groups, '绘画')[0].sections[0].items[0].action,
    'draw',
  );
});

test('drawing becomes a pathless image without creating a thread or uploading a file', async () => {
  const { queue, calls } = setup();
  assert.ok(queue.addInlineImage(drawing()));
  await setImmediate();
  const parts = chatUploadParts(queue.getSnapshot());
  assert.deepEqual(parts, [
    {
      type: 'file',
      filename: 'drawing.png',
      mediaType: 'image/png',
      url: 'data:image/png;base64,aGVsbG8=',
    },
  ]);
  assert.ok(runInputSchema.safeParse({ id: 'drawing-message', parts }).success);
  const displayed = splitMessageAttachments({
    id: 'drawing-message',
    role: 'user',
    parts,
  });
  assert.equal(displayed.attachments.length, 1);
  assert.equal(displayed.attachments[0].workspacePath, undefined);
  assert.equal(queue.getSnapshot()[0].path, undefined);
  queue.cancel(queue.getSnapshot()[0].id);
  await setImmediate();
  assert.deepEqual(calls, []);
});

test('mixed attachments serialize paths for uploaded files only', async () => {
  const { queue, calls } = setup();
  queue.add([new File(['document'], 'notes.txt', { type: 'text/plain' })]);
  queue.addInlineImage(drawing());
  await setImmediate();
  const parts = chatUploadParts(queue.getSnapshot());
  const metadata = parts.find((part) => part.type === 'text');
  assert.ok(metadata?.type === 'text');
  assert.match(metadata.text, /notes\.txt/);
  assert.doesNotMatch(metadata.text, /drawing\.png|undefined/);
  assert.deepEqual(calls, ['thread', 'prepare', 'upload', 'uploaded']);
  queue.commit();
});

test('inline images respect reserved attachment slots and reject oversize files', async () => {
  const { queue, calls } = setup();
  assert.equal(queue.addInlineImage(drawing(), MAX_CHAT_FILES), false);
  assert.deepEqual(calls, ['CHAT_ATTACHMENT_LIMIT']);
  assert.throws(() =>
    queue.addInlineImage(
      new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png', {
        type: 'image/png',
      }),
    ),
  );
  assert.throws(() =>
    queue.addInlineImage(new File(['text'], 'bad.txt', { type: 'text/plain' })),
  );
  assert.equal(queue.getSnapshot().length, 0);
  queue.dispose();
  assert.equal(queue.addInlineImage(drawing()), false);
});

test('cancelling conversion cannot reinsert an image or touch workspace files', async () => {
  let finish!: (value: string) => void;
  const { queue, calls } = setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  queue.addInlineImage(drawing());
  assert.throws(() => chatUploadParts(queue.getSnapshot()), /not ready/);
  queue.cancel(queue.getSnapshot()[0].id);
  finish('data:image/png;base64,aGVsbG8=');
  await setImmediate();
  assert.deepEqual(queue.getSnapshot(), []);
  assert.deepEqual(calls, []);
});

test('failed conversion can retry without falling back to a workspace upload', async () => {
  let attempts = 0;
  const { queue, calls } = setup(async () => {
    if (++attempts === 1) throw new Error('read failed');
    return 'data:image/png;base64,aGVsbG8=';
  });
  queue.addInlineImage(drawing());
  await setImmediate();
  assert.equal(queue.getSnapshot()[0].status, 'error');
  assert.throws(() => chatUploadParts(queue.getSnapshot()), /not ready/);
  queue.retry(queue.getSnapshot()[0].id);
  await setImmediate();
  assert.equal(chatUploadParts(queue.getSnapshot()).length, 1);
  assert.deepEqual(calls, ['error']);
  queue.commit();
});
