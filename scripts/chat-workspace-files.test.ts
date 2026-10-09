import assert from 'node:assert/strict';
import test from 'node:test';
import { filesApi } from '../apps/web/src/components/file-manager/api.js';
import { createWorkspaceFileClient } from '../apps/web/src/components/file-manager/workspace-client.js';

test('switching project threads does not fetch files; subsequent actions use the current thread', async () => {
  const requests: string[] = [];
  const client = createWorkspaceFileClient({
    ...filesApi,
    list: async (id) => {
      requests.push(`list:${id}`);
      return { entries: [], truncated: false };
    },
    preview: async (id, path) => {
      requests.push(`preview:${id}`);
      return {
        path,
        kind: 'text',
        text: '',
        mime: 'text/plain',
        size: 0,
        modifiedAt: '',
      };
    },
    search: async (id) => {
      requests.push(`search:${id}`);
      return { matches: [], truncated: false };
    },
    mutate: async (id, input) => {
      requests.push(`mutate:${id}`);
      return { path: input.path };
    },
  });
  client.setThread('a');
  await client.list('');
  client.setThread('b');
  assert.deepEqual(requests, ['list:a']);
  await client.preview('plan.md');
  await client.search('plan');
  await client.mutate({ operation: 'create', kind: 'file', path: 'plan.md' });
  await client.list('');
  assert.deepEqual(requests, [
    'list:a',
    'preview:b',
    'search:b',
    'mutate:b',
    'list:b',
  ]);
  assert.match(client.raw('plan.md'), /\/threads\/b\/files\/raw/);
});

test('a new-chat draft retains project file access, while another workspace starts isolated', () => {
  const current = createWorkspaceFileClient();
  current.setThread('existing');
  current.setThread(undefined);
  assert.match(current.raw('plan.md'), /\/threads\/existing\/files\/raw/);
  const next = createWorkspaceFileClient();
  assert.throws(() => next.raw('plan.md'), /requires a thread/);
  next.setThread('other-project');
  assert.match(next.raw('plan.md'), /\/threads\/other-project\/files\/raw/);
  assert.match(current.raw('plan.md'), /\/threads\/existing\/files\/raw/);
});

test('an in-flight project file read remains valid when the access thread changes', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  let requestedThread = '';
  const client = createWorkspaceFileClient({
    ...filesApi,
    list: async (id, _path, signal) => {
      requestedThread = id;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      assert.equal(signal?.aborted, false);
      return {
        entries: [{ name: 'plan.md', path: 'plan.md', kind: 'file' }],
        truncated: false,
      };
    },
  });
  client.setThread('a');
  const pending = client.list('', controller.signal);
  client.setThread('b');
  finish();
  assert.equal(requestedThread, 'a');
  assert.equal((await pending).entries[0].name, 'plan.md');
  assert.match(client.raw('plan.md'), /\/threads\/b\/files\/raw/);
});
