import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { PgVector } from '@mastra/pg';
import type { EmbeddingModel } from 'ai';
import { createDataSource, KnowledgeDocumentRecord } from '@aime/db';
import { emptyModelDefaults } from '@aime/shared/providers';
import { XinferenceProvider } from '../../mastra/providers/xinference.js';
import { createKnowledgeEmbedder } from './embedding.js';
import { KnowledgeService } from './service.js';
import { KnowledgeWorker } from './worker.js';

test('a document can wait over three minutes for Xinference embeddings', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Native AbortSignal deadlines use internal timers outside the mock clock.
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Expired', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const embed = createKnowledgeEmbedder(
    {
      getEmbeddingModel: async (_reference, options) =>
        new XinferenceProvider(
          { id: 'test', baseUrl: 'https://model.example', ...options },
          async (url, request) => {
            started();
            await new Promise<void>((resolve) => setTimeout(resolve, 200_000));
            request.signal.throwIfAborted();
            assert.equal(request.timeoutMs, 0);
            return {
              url,
              status: 200,
              headers: {},
              body: Buffer.from(
                JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }),
              ),
            };
          },
        ).embeddingModel('model'),
      getImageEmbeddingModel: async () => null,
    },
    'test/model',
  );
  const result = embed([{ documentId: 'doc', text: 'example' }], async () => {
    throw new Error('Unexpected image');
  });
  await requestStarted;
  t.mock.timers.tick(200_000);
  assert.deepEqual(await result, [[1, 0]]);
});

test(
  'shutdown releases a stalled import and a new worker reclaims it',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30_000,
  },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'knowledge_shutdown_' + randomBytes(6).toString('hex');
    const pool = new Pool({ connectionString });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options: '-c search_path=' + schema + ',public' },
    });
    const vectors = new PgVector({
      id: schema,
      connectionString,
      schemaName: schema,
    });
    t.after(async () => {
      await vectors.disconnect();
      if (database.isInitialized) await database.destroy();
      await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      await pool.end();
    });
    await pool.query('CREATE SCHEMA "' + schema + '"');
    await database.initialize();
    await database.runMigrations();

    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blockRequest = false;
    let requestSignal: AbortSignal | undefined;
    const model: EmbeddingModel = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'model',
      maxEmbeddingsPerCall: 32,
      supportsParallelCalls: false,
      async doEmbed({ values, abortSignal }) {
        if (blockRequest) {
          blockRequest = false;
          requestSignal = abortSignal;
          started();
          await stalled;
        }
        return { embeddings: values.map(() => [1, 0]), warnings: [] };
      },
    };
    const service = new KnowledgeService(
      database,
      vectors,
      {
        getDefaults: async () => emptyModelDefaults,
        getEmbeddingModel: async () => model,
        getImageEmbeddingModel: async () => null,
        getRerankModel: async () => {
          throw new Error('Unexpected reranker');
        },
      },
      {
        assertMember: async () => {
          throw new Error('Unexpected project');
        },
      },
    );
    const base = await service.create(
      'owner',
      { scope: 'personal' },
      { name: 'Docs', embeddingModel: 'test/model' },
    );
    const doc = await service.import('owner', base.id, {
      type: 'text',
      name: 'Note',
      content: 'example',
    });
    const status = () =>
      database.manager.findOneByOrFail(KnowledgeDocumentRecord, { id: doc.id });
    const worker = new KnowledgeWorker(service);
    blockRequest = true;
    worker.start();
    try {
      await requestStarted;
      await worker.stop();
      assert.equal(requestSignal?.aborted, true);
      const interrupted = await status();
      assert.equal(interrupted.status, 'processing');
      assert.equal(interrupted.error, null);
      await new KnowledgeWorker(service).drain();
      // The uncooperative model may still finish after the new worker commits.
    } finally {
      release();
      await worker.stop();
    }
    const finished = await status();
    assert.equal(finished.status, 'ready');
    assert.equal(finished.chunkCount, 1);
    assert.equal(finished.error, null);
  },
);
