import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
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
import sharp from 'sharp';
import { ORPCError } from '@orpc/server';
import { MockImageModelV3 } from 'ai/test';
import { createApp } from '../../app.js';
import { ToolService } from '../tools/service.js';
import type { GroupChatService } from './service.js';
import type { ThreadService } from '../threads/service.js';
import {
  getRoomAgentAvatarUrls,
  saveRoomAgentAvatar,
} from './agent-avatars.js';

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
// Two frames alternating red and blue every 100 ms.
const animatedGif = Buffer.from(
  'R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAQoAAQAsAAAAAAEAAQCBAAD/AAAAAAAAAAAACAQAAQQEADs=',
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
  await writeFile(join(directory, 'artist.gif'), animatedGif);
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
  await rm(join(directory, 'artist.jpg'));
  assert.equal(
    new URL((await discover()).artist, 'http://localhost').searchParams.get(
      'path',
    ),
    '.agents/agents/artist.gif',
  );
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
  await filesystem.writeFile(
    '/.uploads/.agents/agents/editor.gif',
    animatedGif,
  );
  const { threads } = threadFiles(filesystem);
  const urls = await getRoomAgentAvatarUrls(threads, 'viewer', agents);
  assert.deepEqual(Object.keys(urls).sort(), ['artist', 'editor']);
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
  for (const [url, mime, bytes] of [
    [urls.artist, 'image/png', png],
    [urls.editor, 'image/gif', animatedGif],
  ] as const) {
    assert.equal((await app.request(url)).status, 401);
    const response = await app.request(url, {
      headers: { cookie: 'session=test' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mime);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const replacement = await saveRoomAgentAvatar(
    filesystem,
    agents[0].threadId,
    'artist',
    await sharp(png).webp().toBuffer(),
  );
  assert.equal(
    (await getRoomAgentAvatarUrls(threads, 'viewer', agents)).artist,
    replacement.url,
  );
  assert.match(replacement.url, /artist\.webp/);
});

test('unavailable room storage yields an empty avatar map', async () => {
  const threads = {
    withWorkspaceFiles: async () => {
      throw new Error('offline');
    },
  };
  assert.deepEqual(await getRoomAgentAvatarUrls(threads, 'viewer', agents), {});
});

test('avatar RPCs enforce room management, preview with the configured image tool, and publish validated images', async (t) => {
  const root = await workspace(t);
  const { threads } = threadFiles(root);
  const roomId = 'room000000000001';
  const agentId = 'artist0000000001';
  const origin = 'https://room.example';
  let canManage = true;
  let enabled = true;
  let calls = 0;
  const auth = {
    api: { getSession: async () => ({ user: { id: 'viewer' } }) },
  } as unknown as Auth;
  const rooms = {
    agentAvatarThread: async (userId: string, room: string, member: string) => {
      assert.deepEqual([userId, room, member], ['viewer', roomId, agentId]);
      if (!canManage) throw new ORPCError('FORBIDDEN');
      return agents[0].threadId;
    },
  } as unknown as GroupChatService;
  const model = new MockImageModelV3({
    doGenerate: async ({ prompt }) => {
      calls++;
      assert.equal(prompt, 'A blue bird');
      return {
        images: [png],
        warnings: [],
        response: {
          timestamp: new Date(),
          modelId: 'fixture',
          headers: undefined,
        },
      };
    },
  });
  const tools = new ToolService(
    {
      getRepository: () => ({
        findOneBy: async () => ({ value: { enabled, model: 'fixture/bird' } }),
      }),
    } as never,
    {
      getModel: async () => ({ enabled: true, modalitiesOutput: ['image'] }),
      getProviderInstance: async () => ({
        imageModel: (id: string) => {
          assert.equal(id, 'bird');
          return model;
        },
      }),
    } as never,
  );
  const app = createApp(
    auth,
    undefined,
    {
      groupChats: rooms,
      threads: threads as ThreadService,
      models: {} as never,
      webOrigin: origin,
    },
    undefined,
    undefined,
    undefined,
    { service: tools, webOrigin: origin },
  );
  const post = (action: string, body: BodyInit, json = false) =>
    app.request(`${origin}/api/rpc/groupChats/${action}`, {
      method: 'POST',
      headers: {
        origin,
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      body,
    });
  const preview = () =>
    post(
      'generateAgentAvatar',
      JSON.stringify({
        json: { params: { roomId, agentId }, body: { prompt: 'A blue bird' } },
      }),
      true,
    );
  const save = (file: File) => {
    const form = new FormData();
    form.set(
      'data',
      JSON.stringify({
        json: { params: { roomId, agentId }, body: {} },
        maps: [['body']],
      }),
    );
    form.set('0', file);
    return post('saveAgentAvatar', form);
  };
  const upload = new File([new Uint8Array(animatedGif)], 'ignored.gif', {
    type: 'image/gif',
  });
  canManage = false;
  assert.equal((await preview()).status, 403);
  assert.equal((await save(upload)).status, 403);
  canManage = true;
  enabled = false;
  assert.equal((await preview()).status, 409);
  assert.equal(calls, 0);
  enabled = true;
  const response = await preview();
  assert.equal(response.status, 200);
  const generated = (await response.formData()).get('0');
  assert.ok(generated instanceof File && generated.type === 'image/png');
  const savedPath = join(root, '.agents', 'agents', agentId + '.webp');
  await assert.rejects(readFile(savedPath), { code: 'ENOENT' });
  assert.equal((await save(generated)).status, 200);
  const saved = await save(upload);
  assert.equal(saved.status, 200);
  const {
    json: { url },
  } = await saved.json();
  assert.equal(
    (
      await getRoomAgentAvatarUrls(threads, 'viewer', [
        agents[0],
        { ...agents[1], id: agentId },
      ])
    )[agentId],
    url,
  );
  const bytes = await readFile(savedPath);
  const info = await sharp(bytes, { animated: true }).metadata();
  assert.equal(info.width, 512);
  assert.equal(info.pageHeight, 512);
  assert.equal(info.pages, 2);
  assert.deepEqual(info.delay, [100, 100]);
  assert.equal(
    (await save(new File(['invalid'], 'bad.png', { type: 'image/png' })))
      .status,
    400,
  );
  assert.deepEqual(await readFile(savedPath), bytes);
  assert.equal(calls, 1);
});
