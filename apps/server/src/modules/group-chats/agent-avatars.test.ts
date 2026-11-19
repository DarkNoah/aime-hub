import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  CompositeFilesystem,
  LocalFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import { Hono } from 'hono';
import type { Auth } from '@aime/auth';
import { fileRoutes } from '../files/routes.js';
import type { ThreadService } from '../threads/service.js';
import { getRoomAgentAvatarUrls } from './agent-avatars.js';

const agents = [
  { id: 'leader', threadId: 'leader-thread', role: 'bot' },
  { id: 'artist', threadId: 'artist-thread', role: 'worker' },
  { id: 'editor', threadId: 'editor-thread', role: 'worker' },
] as const;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
const jpg = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVL//2Q==',
  'base64',
);

async function workspace(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'room-avatars-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function threadFiles(root: string | WorkspaceFilesystem) {
  let opens = 0;
  const threads: Pick<ThreadService, 'withWorkspaceFiles'> = {
    async withWorkspaceFiles(userId, threadId, action) {
      opens++;
      assert.equal(userId, 'viewer');
      assert.equal(threadId, 'leader-thread');
      return action(root);
    },
  };
  return { threads, opens: () => opens };
}

test('room details discover new avatars by member ID and pick up file replacements', async (t) => {
  const root = await workspace(t);
  const { threads, opens } = threadFiles(root);
  const discover = () => getRoomAgentAvatarUrls(threads, 'viewer', agents);
  assert.deepEqual(await discover(), {});
  const directory = join(root, '.agents/agents');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'artist.jpg'), jpg);
  await writeFile(join(directory, 'leader.png'), png);
  await writeFile(join(directory, 'unrelated.png'), png);
  await symlink(join(directory, 'leader.png'), join(directory, 'editor.png'));
  const urls = await discover();
  assert.equal(opens(), 2);
  assert.deepEqual(Object.keys(urls).sort(), ['artist', 'leader']);
  assert.equal(
    new URL(urls.artist, 'http://localhost').searchParams.get('path'),
    '.agents/agents/artist.jpg',
  );
  await writeFile(join(directory, 'artist.png'), png);
  const preferred = (await discover()).artist;
  assert.equal(
    new URL(preferred, 'http://localhost').searchParams.get('path'),
    '.agents/agents/artist.png',
  );
  await utimes(join(directory, 'artist.png'), new Date(0), new Date(0));
  assert.notEqual((await discover()).artist, preferred);
  await rm(join(directory, 'artist.png'));
  assert.equal((await discover()).artist, urls.artist);
});

test('composite room avatars resolve through the authenticated thread file route', async (t) => {
  const root = await workspace(t);
  const filesystem = new CompositeFilesystem({
    mounts: {
      '/.uploads': new LocalFilesystem({
        basePath: join(root, '.uploads'),
        contained: true,
      }),
    },
  });
  await filesystem.init();
  t.after(() => filesystem.destroy());
  await filesystem.mkdir('/.uploads/.agents/agents', { recursive: true });
  await filesystem.writeFile('/.uploads/.agents/agents/artist.png', png);
  const { threads } = threadFiles(filesystem);
  const urls = await getRoomAgentAvatarUrls(threads, 'viewer', agents);
  assert.deepEqual(Object.keys(urls), ['artist']);
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.has('cookie') ? { user: { id: 'viewer' } } : null,
    },
  } as unknown as Auth;
  const app = new Hono().route(
    '/api/threads/:threadId/files',
    fileRoutes(auth, threads as ThreadService),
  );
  assert.equal((await app.request(urls.artist)).status, 401);
  const response = await app.request(urls.artist, {
    headers: { cookie: 'session=test' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('unavailable room storage yields an empty avatar map', async () => {
  const threads = {
    withWorkspaceFiles: async () => {
      throw new Error('offline');
    },
  };
  assert.deepEqual(await getRoomAgentAvatarUrls(threads, 'viewer', agents), {});
});
