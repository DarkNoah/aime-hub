import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  chatDraftKey,
  clearChatDraft,
  readChatDraft,
  writeChatDraft,
} from '../apps/web/src/components/chat/draft-storage.js';

let values: Map<string, string>;
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage',
);
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
});
afterEach(() => {
  if (originalStorage)
    Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('thread, new personal chat, project and account drafts stay separate', () => {
  const scopes = [
    { userId: 'alice', threadId: 'first' },
    { userId: 'alice', threadId: 'second' },
    { userId: 'alice' },
    { userId: 'alice', projectId: 'first' },
    { userId: 'alice', projectId: 'second' },
    { userId: 'bob', threadId: 'first' },
    { userId: 'bob' },
  ];
  scopes.forEach((scope, index) => {
    writeChatDraft(chatDraftKey(scope), `draft ${index}`);
  });
  scopes.forEach((scope, index) => {
    assert.equal(readChatDraft(chatDraftKey(scope)), `draft ${index}`);
  });
  assert.equal(values.size, scopes.length);
  assert.equal(
    chatDraftKey({ userId: 'alice', threadId: 'first', projectId: 'project' }),
    chatDraftKey(scopes[0]),
  );
});

test('reopening a draft restores exact multiline text and whitespace', () => {
  const scope = { userId: 'alice', threadId: 'first' };
  const text = '  未发送的消息\n第二行 🙂\n  ';
  writeChatDraft(chatDraftKey(scope), text);
  assert.equal(readChatDraft(chatDraftKey({ ...scope })), text);
});

test('editing to an empty string removes the stored draft', () => {
  const key = chatDraftKey({ userId: 'alice' });
  writeChatDraft(key, 'draft');
  writeChatDraft(key, '');
  assert.equal(readChatDraft(key), '');
  assert.equal(values.size, 0);
});

test('a completed send clears only its original scope after navigation', () => {
  const originalKey = chatDraftKey({ userId: 'alice' });
  const nextKey = chatDraftKey({ userId: 'alice', threadId: 'created' });
  writeChatDraft(originalKey, 'first message');
  writeChatDraft(nextKey, 'follow-up');
  clearChatDraft(originalKey, 'first message');
  assert.equal(values.has(originalKey!), false);
  assert.equal(readChatDraft(nextKey), 'follow-up');
});

test('a late send completion preserves a newer draft in the same scope', () => {
  const key = chatDraftKey({ userId: 'alice', projectId: 'first' });
  writeChatDraft(key, 'sent message');
  writeChatDraft(key, 'new draft after returning');
  clearChatDraft(key, 'sent message');
  assert.equal(readChatDraft(key), 'new draft after returning');
});

test('no draft is read or stored before the user is known', () => {
  const key = chatDraftKey({ threadId: 'first' });
  assert.equal(key, null);
  writeChatDraft(key, 'draft');
  clearChatDraft(key, 'draft');
  assert.equal(readChatDraft(key), '');
  assert.equal(values.size, 0);
});

test('blocked storage access does not break the composer', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('Storage denied');
    },
  });
  const key = chatDraftKey({ userId: 'alice' });
  assert.equal(readChatDraft(key), '');
  assert.doesNotThrow(() => writeChatDraft(key, 'draft'));
  assert.doesNotThrow(() => clearChatDraft(key, 'draft'));
});

test('storage quota and deletion failures do not throw', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => 'draft',
      setItem() {
        throw new Error('Quota exceeded');
      },
      removeItem() {
        throw new Error('Storage denied');
      },
    },
  });
  const key = chatDraftKey({ userId: 'alice' });
  assert.doesNotThrow(() => writeChatDraft(key, 'new draft'));
  assert.doesNotThrow(() => clearChatDraft(key, 'draft'));
});
