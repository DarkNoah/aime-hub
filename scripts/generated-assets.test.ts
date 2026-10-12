import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { GeneratedAsset, createDataSource } from '@aime/db';
import { AddGeneratedAssetMetadata1780000011000 } from '../packages/db/src/migrations/1780000011000-add-generated-asset-metadata.js';
import { AddGeneratedAssetCreator1780000010000 } from '../packages/db/src/migrations/1780000010000-add-generated-asset-creator.js';
import { CreateGeneratedAssets1780000009000 } from '../packages/db/src/migrations/1780000009000-create-generated-assets.js';
import { assetMetadataSchema, assetQuerySchema } from '@aime/shared/assets';
import { MAX_IMAGE_BYTES, runInputSchema } from '@aime/shared/threads';
import { AssetService } from '../apps/server/src/modules/assets/service.js';
import { prepareAssetAttachments } from '../apps/server/src/modules/assets/attachments.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import { createApp } from '../apps/server/src/app.js';
import { createApiClient } from '../apps/web/src/lib/rpc.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQmcAAAAASUVORK5CYII=',
  'base64',
);
const threadId = 'thread0000000001';
const otherThread = 'thread0000000002';
const projectId = 'project000000001';
const origin = 'http://localhost:5173';

test('asset metadata accepts extensible JSON and validates known dimensions', () => {
  const metadata = {
    width: 1024,
    height: 768,
    duration: 2.5,
    codec: 'av1',
    extra: { tags: ['demo'], alpha: true, note: null },
  };
  assert.deepEqual(assetMetadataSchema.parse(metadata), metadata);
  assert.deepEqual(assetMetadataSchema.parse({}), {});
  for (const invalid of [
    null,
    [],
    'image',
    { width: 0 },
    { height: -1 },
    { width: 1.5 },
    { height: '768' },
    { duration: Infinity },
    { extra: () => 1 },
  ])
    assert.equal(assetMetadataSchema.safeParse(invalid).success, false);
});

test('asset scope automatically limits personal chats to the thread and projects to active project threads', async () => {
  const entries = [
    { id: threadId, resourceId: 'user:owner', metadata: {} },
    { id: otherThread, resourceId: 'user:owner', metadata: {} },
    {
      id: 'archived00000001',
      resourceId: 'user:owner',
      metadata: { archivedAt: new Date().toISOString() },
    },
    {
      id: 'hidden0000000001',
      resourceId: 'user:owner',
      metadata: { goalJudge: true },
    },
    {
      id: 'projectthread002',
      resourceId: `project:${projectId}`,
      metadata: {},
    },
    {
      id: 'projectarchived1',
      resourceId: `project:${projectId}`,
      metadata: { archivedAt: new Date().toISOString() },
    },
    {
      id: 'projecthidden01',
      resourceId: `project:${projectId}`,
      metadata: { goalJudge: true },
    },
    {
      id: 'projectthread001',
      resourceId: `project:${projectId}`,
      metadata: {},
    },
  ];
  const memory = {
    getThreadById: async ({ threadId: id }: { threadId: string }) =>
      entries.find((entry) => entry.id === id),
    listThreads: async ({ filter }: { filter: { resourceId: string } }) => ({
      threads: entries.filter(
        (entry) => entry.resourceId === filter.resourceId,
      ),
    }),
  };
  const projects = {
    assertMember: async (user: string) => {
      if (user !== 'member') throw new ThreadError('PROJECT_NOT_FOUND', 404);
      return { role: 'member' };
    },
  };
  const threads = new ThreadService(
    memory as never,
    {} as never,
    projects as never,
  );
  assert.deepEqual(await threads.assetScope('owner', threadId), {
    resourceId: 'user:owner',
    threadIds: [threadId],
  });
  await assert.rejects(threads.assetScope('stranger', threadId), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(threads.assetScope('owner', 'archived00000001'), {
    code: 'THREAD_NOT_FOUND',
  });
  await assert.rejects(threads.assetScope('owner', 'projectthread001'), {
    code: 'PROJECT_NOT_FOUND',
  });
  assert.deepEqual(await threads.assetScope('member', 'projectthread001'), {
    resourceId: `project:${projectId}`,
    threadIds: ['projectthread002', 'projectthread001'],
  });
});

test('asset HTTP/RPC requires authentication, validates filters and protects attach origin', async (t) => {
  let user: { id: string } | undefined = undefined;
  const calls: unknown[] = [];
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as Parameters<typeof createApp>[0];
  const assets = {
    list: async (
      _threads: unknown,
      owner: string,
      id: string,
      query: unknown,
    ) => {
      calls.push({ owner, id, query });
      return { items: [], nextCursor: null };
    },
    attach: async () => ({ parts: [{ type: 'text', text: 'attachment' }] }),
  } as unknown as AssetService;
  const app = createApp(auth, undefined, {
    threads: {} as ThreadService,
    models: {} as never,
    assets,
    webOrigin: origin,
  });
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) =>
    app.request(
      new Request(request, {
        headers: { ...Object.fromEntries(request.headers), origin },
      }),
    ),
  );
  await assert.rejects(
    client.assets.list({ params: { threadId }, query: {} }),
    { code: 'UNAUTHORIZED' },
  );
  user = { id: 'owner' };
  assert.deepEqual(
    await client.assets.list({ params: { threadId }, query: {} }),
    { items: [], nextCursor: null },
  );
  assert.equal(calls.length, 1);
  const legacyScope = await app.request(
    `/api/threads/${threadId}/assets?scope=resource`,
  );
  assert.equal(legacyScope.status, 200);
  assert.equal('scope' in (calls.at(-1) as { query: object }).query, false);
  for (const query of ['kind=invalid', 'sort=random', 'limit=101'])
    assert.equal(
      (await app.request(`/api/threads/${threadId}/assets?${query}`)).status,
      400,
    );
  const attach = `/api/threads/${threadId}/assets/attach`;
  assert.equal(
    (
      await app.request(attach, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [randomUUID()] }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(attach, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          ids: Array.from({ length: 5 }, () => randomUUID()),
        }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await client.assets.attach({
        params: { threadId },
        body: { ids: [randomUUID()] },
      })
    ).parts[0].type,
    'text',
  );
});

test('attachments copy across personal workspaces, preserve same-thread paths, and bound inline images', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'asset-files-')));
  const target = await realpath(await mkdtemp(join(tmpdir(), 'asset-target-')));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });
  await writeFile(join(root, 'small.png'), png);
  await writeFile(
    join(root, 'large.png'),
    Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]),
  );
  await writeFile(join(root, 'sound.mp3'), Buffer.from('audio fixture'));
  const threads = {
    withWorkspaceFiles: async (
      _user: string,
      id: string,
      action: (root: string) => Promise<unknown>,
    ) => action(id === threadId ? root : target),
  } as Pick<ThreadService, 'withWorkspaceFiles'>;
  const asset = {
    id: randomUUID(),
    threadId,
    resourceId: 'user:owner',
    path: 'small.png',
    name: 'small.png',
    kind: 'image',
    mimeType: 'image/png',
  } as GeneratedAsset;
  const inline = await prepareAssetAttachments(threads, 'owner', threadId, [
    asset,
  ]);
  assert.equal(inline.parts[0].type, 'file');
  assert.match(JSON.stringify(inline.parts), /small.png/);
  const copied = await prepareAssetAttachments(threads, 'owner', otherThread, [
    asset,
  ]);
  assert.deepEqual(
    await readFile(join(target, `attachments/${asset.id}.png`)),
    png,
  );
  assert.match(JSON.stringify(copied.parts), /attachments\//);
  // Retrying reuses a previously copied attachment, including the existing directory.
  assert.deepEqual(
    await prepareAssetAttachments(threads, 'owner', otherThread, [asset]),
    copied,
  );
  const media = await prepareAssetAttachments(threads, 'owner', otherThread, [
    { ...asset, id: randomUUID(), path: 'large.png', name: 'large.png' },
    {
      ...asset,
      id: randomUUID(),
      path: 'sound.mp3',
      name: 'sound.mp3',
      kind: 'audio',
      mimeType: 'audio/mpeg',
    },
  ]);
  assert.deepEqual(
    media.parts.map((part) => part.type),
    ['text'],
  );
  assert.match(JSON.stringify(media.parts), /audio\/mpeg/);
  assert.equal(
    runInputSchema.safeParse({
      id: 'message001',
      parts: [...copied.parts, { type: 'text', text: 'Use it' }],
    }).success,
    true,
  );
  await symlink(join(root, 'small.png'), join(root, 'unsafe.png'));
  await assert.rejects(
    prepareAssetAttachments(threads, 'owner', threadId, [
      { ...asset, path: 'unsafe.png' },
    ]),
    { code: 'FILE_SYMLINK' },
  );
  await assert.rejects(
    prepareAssetAttachments(
      threads,
      'owner',
      threadId,
      [asset],
      AbortSignal.abort(),
    ),
  );
});

test(
  'Postgres asset migration, idempotency, resource isolation, keyset sorting and attachment permissions',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `assets_test_${randomBytes(8).toString('hex')}`;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const database = createDataSource(
      process.env.TEST_DATABASE_URL!,
    ).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
      migrations: [
        CreateGeneratedAssets1780000009000,
        AddGeneratedAssetCreator1780000010000,
        AddGeneratedAssetMetadata1780000011000,
      ],
    });
    t.after(async () => {
      if (database.isInitialized) await database.destroy();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.runMigrations();
    const service = new AssetService(database);
    const scope = {
      assetScope: async () => ({
        resourceId: `project:${projectId}`,
        threadIds: [threadId, otherThread],
      }),
    };
    const input = {
      threadId,
      resourceId: `project:${projectId}`,
      createdBy: 'creator',
      path: 'outputs/images/a.png',
      mimeType: 'image/png',
      size: 100,
      metadata: {
        width: 1,
        height: 1,
        format: 'png',
        extra: { tags: ['generated'], transparent: false },
      },
      toolName: 'image_gen',
      toolCallId: 'call',
    };
    await Promise.all([service.record(input), service.record(input)]);
    assert.equal(await database.getRepository(GeneratedAsset).count(), 1);
    assert.equal(
      (
        await database
          .getRepository(GeneratedAsset)
          .findOneByOrFail({ path: input.path })
      ).createdBy,
      'creator',
    );
    await service.record({
      ...input,
      path: 'outputs/images/b.png',
      threadId: otherThread,
      size: 300,
    });
    await service.record({
      ...input,
      path: 'outputs/audio.mp3',
      mimeType: 'audio/mpeg',
      metadata: { duration: 12.5, sampleRate: 44100 },
      size: 200,
    });
    await service.record({
      ...input,
      resourceId: 'user:stranger',
      path: 'private.png',
    });
    await service.record({
      ...input,
      threadId: 'deleted-thread',
      path: 'orphan.png',
      metadata: undefined,
    });
    await database
      .getRepository(GeneratedAsset)
      .createQueryBuilder()
      .update()
      .set({ createdAt: new Date('2026-10-11T00:00:00.123Z') })
      .execute();
    for (const sort of ['newest', 'oldest', 'name', 'largest'] as const) {
      let cursor: string | undefined;
      const ids: string[] = [];
      const sizes: number[] = [];
      do {
        const page = await service.list(
          scope,
          'owner',
          threadId,
          assetQuerySchema.parse({ sort, limit: 1, cursor }),
        );
        for (const asset of page.items) {
          assert.deepEqual(
            asset.metadata,
            asset.kind === 'audio'
              ? { duration: 12.5, sampleRate: 44100 }
              : input.metadata,
          );
          assert.equal('width' in asset, false);
        }
        ids.push(...page.items.map((asset) => asset.id));
        sizes.push(...page.items.map((asset) => asset.size));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(ids.length, 3);
      assert.equal(new Set(ids).size, 3);
      if (sort === 'largest') assert.deepEqual(sizes, [300, 200, 100]);
    }
    assert.equal(
      (await service.list(scope, 'owner', threadId, assetQuerySchema.parse({})))
        .items.length,
      3,
    );
    assert.equal(
      (
        await service.list(
          scope,
          'owner',
          threadId,
          assetQuerySchema.parse({ kind: 'audio' }),
        )
      ).items.length,
      1,
    );
    assert.equal(
      (
        await service.list(
          scope,
          'owner',
          threadId,
          assetQuerySchema.parse({ search: '%' }),
        )
      ).items.length,
      0,
    );
    assert.equal(
      (
        await service.list(
          scope,
          'owner',
          threadId,
          assetQuerySchema.parse({ search: 'a.png' }),
        )
      ).items.length,
      1,
    );
    await assert.rejects(
      service.list(
        scope,
        'owner',
        threadId,
        assetQuerySchema.parse({ cursor: 'invalid' }),
      ),
      { code: 'VALIDATION_ERROR' },
    );
    const foreign = await database
      .getRepository(GeneratedAsset)
      .findOneByOrFail({ resourceId: 'user:stranger' });
    await assert.rejects(
      service.attach(
        {
          ...scope,
          withWorkspaceFiles: async () => {
            throw new Error('Must not access workspace');
          },
        },
        'owner',
        threadId,
        [foreign.id],
      ),
      { code: 'FILE_NOT_FOUND' },
    );
    await assert.rejects(service.record({ ...input, path: '../escape.png' }), {
      code: 'FILE_INVALID_PATH',
    });
    assert.deepEqual(
      (
        await database
          .getRepository(GeneratedAsset)
          .findOneByOrFail({ path: 'orphan.png' })
      ).metadata,
      {},
    );
    await assert.rejects(service.record({ ...input, metadata: { width: -1 } }));
    // Rollback restores legacy columns, and re-applying preserves dimensions without null keys.
    await database.undoLastMigration();
    assert.deepEqual(
      await database.query(
        'SELECT width, height FROM generated_assets WHERE path = $1',
        [input.path],
      ),
      [{ width: 1, height: 1 }],
    );
    await database.runMigrations();
    assert.deepEqual(
      (
        await database
          .getRepository(GeneratedAsset)
          .findOneByOrFail({ path: input.path })
      ).metadata,
      { width: 1, height: 1 },
    );
    assert.deepEqual(
      (
        await database
          .getRepository(GeneratedAsset)
          .findOneByOrFail({ path: 'orphan.png' })
      ).metadata,
      {},
    );
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.query(
      "UPDATE generated_assets SET resource_id = 'user:legacy-owner' WHERE path = $1",
      [input.path],
    );
    await database.runMigrations();
    assert.equal(
      (
        await database
          .getRepository(GeneratedAsset)
          .findOneByOrFail({ path: input.path })
      ).createdBy,
      'legacy-owner',
    );
    assert.equal(
      (
        await database
          .getRepository(GeneratedAsset)
          .findOneByOrFail({ path: 'outputs/images/b.png' })
      ).createdBy,
      null,
    );
    await database.undoLastMigration();
    await database.undoLastMigration();
    await database.undoLastMigration();
    assert.equal(
      (
        await database.query("SELECT to_regclass('generated_assets') AS table")
      )[0].table,
      null,
    );
    await database.runMigrations();
  },
);
