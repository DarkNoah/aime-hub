import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PgVector } from '@mastra/pg';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { RequestContext } from '@mastra/core/request-context';
import type { EmbeddingModel, RerankingModel } from 'ai';
import { createDataSource, KnowledgeBaseRecord as Base } from '@aime/db';
import { loadEnv } from '@aime/shared/env';
import { emptyModelDefaults } from '@aime/shared/providers';
import { createImageEmbeddingModel } from '../../mastra/providers/openai-compatible-retrieval.js';
import { createKnowledgeTools } from '../../mastra/tools/knowledge.js';
import { parseKnowledgeSource, validateKnowledgeFile } from './parse.js';
import { KnowledgeService } from './service.js';
import { KnowledgeWorker } from './worker.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j01sAAAAASUVORK5CYII=',
  'base64',
);

test('images validate bytes and remain one native input even without text or OCR', async () => {
  assert.equal(validateKnowledgeFile('photo.JPEG', png)?.mimeType, 'image/png');
  assert.throws(
    () => validateKnowledgeFile('photo.png', Buffer.from('fake')),
    /KNOWLEDGE_FILE_TYPE/,
  );
  const result = await parseKnowledgeSource({
    sourceType: 'file',
    name: 'Display title',
    sourceName: 'photo.png',
    sourceUrl: null,
    sourceData: png,
  });
  assert.equal(result.inputType, 'image');
  assert.equal(result.texts.length, 1);
});

test('image adapter sends native image objects and validates response indexes', async () => {
  let invalid = false;
  const model = createImageEmbeddingModel(
    { id: 'fixture', type: 'openai', baseUrl: 'https://fixture.example/v1' },
    'jina-embeddings-v4',
    async (url, options) => {
      assert.equal(url, 'https://fixture.example/v1/embeddings');
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body.input, [
        { image: `data:image/png;base64,${png.toString('base64')}` },
        { image: `data:image/png;base64,${png.toString('base64')}` },
      ]);
      return {
        status: 200,
        headers: {},
        url,
        body: Buffer.from(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: invalid ? 1 : 0, embedding: [1, 0] },
            ],
          }),
        ),
      };
    },
  );
  const images = [0, 1].map(() => ({ data: png, mimeType: 'image/png' }));
  assert.deepEqual((await model.doEmbedImages({ images })).embeddings, [
    [1, 0],
    [0, 1],
  ]);
  invalid = true;
  await assert.rejects(model.doEmbedImages({ images }), /indices/);
  await assert.rejects(
    model.doEmbedImages({ images, abortSignal: AbortSignal.abort() }),
    /abort/i,
  );
});

test('native image ingestion, reads, retrieval, versions and rebuilds preserve image bytes', async (t) => {
  const connectionString = loadEnv().DATABASE_URL;
  assert.equal(new URL(connectionString).hostname, '127.0.0.1');
  const schema = `knowledge_images_${randomBytes(6).toString('hex')}`;
  const root = new Pool({ connectionString });
  const db = createDataSource(connectionString).setOptions({
    schema,
    extra: { options: `-c search_path=${schema},public` },
  });
  const vectors = new PgVector({
    id: schema,
    connectionString,
    schemaName: schema,
  });
  t.after(async () => {
    await vectors.disconnect();
    if (db.isInitialized) await db.destroy();
    await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await root.end();
  });
  await root.query(`CREATE SCHEMA "${schema}"`);
  await db.initialize();
  await db.runMigrations();
  let failImage = false,
    supported = true,
    imageCalls = 0,
    rerankCalls = 0;
  const textInputs: string[] = [];
  const providers = {
    getDefaults: async () => ({
      ...emptyModelDefaults,
      embeddingModel: 'test/image',
      rerankModel: 'test/rerank',
    }),
    getEmbeddingModel: async (): Promise<EmbeddingModel> => ({
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'image',
      supportsParallelCalls: false,
      maxEmbeddingsPerCall: 32,
      doEmbed: async ({ values }) => {
        textInputs.push(...values);
        return {
          embeddings: values.map((v) =>
            v.includes('red') ? [1, 0, 0] : [0, 1, 0],
          ),
          warnings: [],
        };
      },
    }),
    getImageEmbeddingModel: async () =>
      supported
        ? {
            doEmbedImages: async ({
              images,
            }: {
              images: { data: Uint8Array; mimeType: string }[];
            }) => {
              imageCalls++;
              assert.equal(images[0]!.mimeType, 'image/png');
              assert.deepEqual(Buffer.from(images[0]!.data), png);
              if (failImage) throw new Error('private-token');
              return { embeddings: [[1, 0, 0]] };
            },
          }
        : null,
    getRerankModel: async (): Promise<RerankingModel> => ({
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'rerank',
      doRerank: async () => {
        rerankCalls++;
        throw new Error('must not rerank labels');
      },
    }),
  };
  const kb = new KnowledgeService(db, vectors, providers, {
    assertMember: async () => {
      throw new Error('unused');
    },
  });
  const worker = new KnowledgeWorker(kb);
  const base = await kb.create(
    'owner',
    { scope: 'personal' },
    { name: 'Pictures' },
  );
  const source = {
    type: 'file' as const,
    name: 'red.png',
    data: png.toString('base64'),
  };
  const doc = await kb.import(
    'owner',
    base.id,
    source,
    undefined,
    'Custom title',
  );
  await worker.drain();
  await t.test(
    'native bytes indexed, protected preview includes image, text embeddings never receive its label',
    async () => {
      assert.equal((await kb.document('owner', doc.id)).status, 'ready');
      assert.equal((await kb.document('owner', doc.id)).image, undefined);
      assert.deepEqual((await kb.document('owner', doc.id, true)).image, {
        data: source.data,
        mimeType: 'image/png',
      });
      await assert.rejects(kb.document('other', doc.id, true), /NOT_FOUND/);
      assert.equal(imageCalls, 1);
      assert.ok(!textInputs.some((v) => v.includes('Custom title')));
      const tools = createKnowledgeTools(kb);
      const ctx = new RequestContext();
      ctx.set('userId', 'owner');
      const result = await tools.knowledge_get_document.execute!(
        { item_id: doc.id, format: 'text', offset: 0, limit: 20 },
        { requestContext: ctx } as never,
      );
      const output = tools.knowledge_get_document.toModelOutput!(result) as {
        type: string;
        value: { type: string; data?: string }[];
      };
      assert.equal(output.type, 'content');
      assert.equal(output.value[1]!.type, 'image-data');
      assert.equal(output.value[1]!.data, source.data);
    },
  );
  await t.test(
    'mixed recall uses complete RRF and metadata edits keep image input type',
    async () => {
      await kb.import('owner', base.id, {
        type: 'text',
        name: 'note',
        content: 'red text note',
      });
      await worker.drain();
      await kb.updateDocument('owner', doc.id, { metadata: {} });
      const hits = await kb.search('owner', base.id, 'red', 10);
      assert.equal(hits.length, 2);
      assert.ok(
        hits.every(
          (hit) =>
            hit.score === hit.scores?.rrf &&
            hit.fallbackReasons?.rerank === 'image_unsupported',
        ),
      );
      assert.equal(
        hits.find((hit) => hit.documentId === doc.id)?.inputType,
        'image',
      );
      assert.equal(rerankCalls, 0);
    },
  );
  await t.test(
    'full rebuild uses original images; text-only target fails without replacing active index',
    async () => {
      const beforeCalls = imageCalls;
      await kb.update('owner', base.id, { embeddingModel: 'test/image2' });
      await worker.drain();
      const current = await kb.get('owner', base.id);
      assert.equal(current.rebuild, null);
      assert.equal(imageCalls, beforeCalls + 1);
      assert.ok(!textInputs.some((v) => v.includes('Custom title')));
      supported = false;
      await kb.update('owner', base.id, { embeddingModel: 'test/text-only' });
      await worker.drain();
      const failed = await kb.get('owner', base.id);
      assert.equal(failed.rebuild?.error, 'KNOWLEDGE_IMAGE_MODEL_REQUIRED');
      assert.equal(failed.vectorIndex, current.vectorIndex);
      supported = true;
    },
  );
  await t.test(
    'provider failure is explicit and retry works without text fallback',
    async () => {
      failImage = true;
      const failed = await kb.import('owner', base.id, source);
      await worker.drain();
      assert.equal(
        (await kb.document('owner', failed.id)).error,
        'KNOWLEDGE_IMAGE_EMBED_FAILED',
      );
      failImage = false;
      await kb.retry('owner', failed.id);
      await worker.drain();
      assert.equal((await kb.document('owner', failed.id)).status, 'ready');
    },
  );
  await t.test(
    'image-to-text version retains original image source and uses text path',
    async () => {
      const calls = imageCalls;
      await kb.createVersion('owner', doc.id, {
        expectedVersion: 1,
        source: {
          type: 'text',
          name: 'replacement',
          content: 'replacement text',
        },
      });
      await worker.drain();
      assert.equal(imageCalls, calls);
      assert.equal((await kb.document('owner', doc.id, true)).image, undefined);
      assert.equal(
        (await kb.versionFile('owner', doc.id, 1)).data,
        source.data,
      );
    },
  );
  await t.test(
    'BM25-only base cannot silently index an image label',
    async () => {
      const textBase = await kb.create(
        'owner',
        { scope: 'personal' },
        { name: 'Text', embeddingModel: null },
      );
      const image = await kb.import('owner', textBase.id, source);
      await worker.drain();
      assert.equal(
        (await kb.document('owner', image.id)).error,
        'KNOWLEDGE_IMAGE_MODEL_REQUIRED',
      );
    },
  );
  assert.equal(
    (await db.manager.findOneByOrFail(Base, { id: base.id })).embeddingModel,
    'test/image2',
  );
});

test('workspace image saves honor explicit file updates, uploaded paths, containment and immediate cancellation', async (t) => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'knowledge-images-')),
  );
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: dir }),
  });
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.uploads'));
  await writeFile(join(dir, '.uploads/test.png'), png);
  await symlink('/etc/passwd', join(dir, 'outside.png'));
  let writes = 0;
  const service = {
    document: async () => ({ id: 'item', baseId: 'base', name: 'Title' }),
    assertConversationAccess: async () => {},
    updateDocument: async (
      _user: string,
      _id: string,
      input: { source: unknown },
    ) => {
      writes++;
      assert.deepEqual(input.source, {
        type: 'file',
        name: 'test.png',
        data: png.toString('base64'),
      });
      return {};
    },
  } as unknown as KnowledgeService;
  const tool = createKnowledgeTools(service).knowledge_save_document;
  const ctx = new RequestContext();
  ctx.set('userId', 'owner');
  const input = {
    item_id: 'item',
    type: 'file' as const,
    source: '/.uploads/test.png',
    action: 'save' as const,
  };
  await tool.execute!(input, { requestContext: ctx, workspace } as never);
  assert.equal(writes, 1);
  await assert.rejects(
    tool.execute!({ ...input, source: 'outside.png' }, {
      requestContext: ctx,
      workspace,
    } as never) as Promise<unknown>,
    /permission|outside/i,
  );
  const pre = await tool.execute!(input, {
    requestContext: ctx,
    workspace,
    abortSignal: AbortSignal.abort(),
  } as never);
  assert.deepEqual(pre, { cancelled: true, message: '用户中止了操作' });
  assert.equal(writes, 1);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = workspace.filesystem!.readFile.bind(workspace.filesystem);
  workspace.filesystem!.readFile = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  const controller = new AbortController();
  const pending = tool.execute!(input, {
    requestContext: ctx,
    workspace,
    abortSignal: controller.signal,
  } as never);
  await started;
  controller.abort();
  const result = await Promise.race([
    pending,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cancel did not return')), 500).unref(),
    ),
  ]);
  assert.deepEqual(result, { cancelled: true, message: '用户中止了操作' });
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes, 1);
});
