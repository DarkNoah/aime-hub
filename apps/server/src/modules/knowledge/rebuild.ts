import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { embedMany } from 'ai';
import {
  KnowledgeBaseRecord as Base,
  KnowledgeDocumentRecord as Document,
} from '@aime/db';
import { ThreadError } from '../threads/errors.js';
import { createKnowledgeEmbedder } from './embedding.js';
import { activeKnowledgeIndex, type KnowledgeService } from './service.js';
import { vectorTableName, type StoredChunk } from './vector-store.js';
import { withSearchTimeout } from './retrieval.js';

type VectorBatch = { chunks: StoredChunk[]; vectors: number[][] | null };

// Invoked only while KnowledgeWorker owns its PostgreSQL advisory session lock.
// Persisted job + per-attempt fencing also protects against a lost lock session.
export async function rebuildKnowledge(service: KnowledgeService, id: string) {
  const { database, providers, vectors } = service;
  const attempt = randomUUID();
  let indexName: string | undefined;
  const claimed = await database.transaction(async (m) => {
    const base = await m.findOne(Base, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !base?.rebuild ||
      !['pending', 'processing'].includes(base.rebuild.status)
    )
      return null;
    if (base.rebuild.indexName)
      base.retiredIndexes.push({
        name: base.rebuild.indexName,
        after: Date.now() + 60_000,
      });
    base.rebuild = {
      ...base.rebuild,
      attempt,
      indexName: undefined,
      status: 'processing',
      completed: 0,
      error: null,
    };
    return m.save(Base, base);
  });
  if (!claimed?.rebuild) return;
  const job = claimed.rebuild;
  let temporary: string | undefined;
  let stage = 'KNOWLEDGE_EMBED_FAILED';
  let dimension: number | null = null;
  try {
    temporary = await mkdtemp(join(tmpdir(), 'knowledge-rebuild-'));
    const path = join(temporary, 'vectors.jsonl');
    const file = await open(path, 'wx', 0o600);
    let completed = 0;
    try {
      const embedChunks = createKnowledgeEmbedder(
        providers,
        job.embeddingModel,
      );
      let after = '';
      while (true) {
        const chunks = await service.store.chunks(claimed, {
          after,
          limit: 32,
        });
        if (!chunks.length) break;
        const batchVectors = await embedChunks(chunks, async (documentId) => {
          const doc = await database
            .getRepository(Document)
            .createQueryBuilder('d')
            .addSelect('d.sourceData')
            .where('d.id = :documentId AND d.base_id = :baseId', {
              documentId,
              baseId: id,
            })
            .getOne();
          if (!doc) throw new Error('Image source unavailable');
          return { name: doc.sourceName ?? doc.name, data: doc.sourceData };
        });
        if (batchVectors) {
          const embeddings = batchVectors;
          dimension ??= embeddings[0]?.length ?? null;
          if (
            !dimension ||
            embeddings.length !== chunks.length ||
            embeddings.some(
              (v) =>
                v.length !== dimension || v.some((n) => !Number.isFinite(n)),
            )
          )
            throw new Error('Invalid embeddings');
        }
        const batch: VectorBatch = { chunks, vectors: batchVectors };
        await file.writeFile(JSON.stringify(batch) + '\n');
        completed += chunks.length;
        after = chunks[chunks.length - 1]!.id;
        const updated: { id: string }[] = await database.query(
          `WITH updated AS (UPDATE knowledge_bases SET rebuild = jsonb_set(rebuild, '{completed}', to_jsonb($3::int))
           WHERE id = $1 AND rebuild->>'attempt' = $2 AND rebuild->>'status' = 'processing' RETURNING id)
           SELECT id FROM updated`,
          [id, attempt, completed],
        );
        if (!updated.length) throw new Error('Rebuild superseded');
      }
      if (job.embeddingModel && dimension === null) {
        const result = await withSearchTimeout(
          async (signal) =>
            embedMany({
              model: await providers.getEmbeddingModel(job.embeddingModel!),
              values: ['dimension probe'],
              maxRetries: 0,
              abortSignal: signal,
            }),
          30_000,
        );
        dimension = result.embeddings[0]?.length ?? null;
        if (!dimension || result.embeddings[0].some((n) => !Number.isFinite(n)))
          throw new Error('Invalid embeddings');
      }
      if (completed !== job.total) throw new Error('Rebuild corpus changed');
    } finally {
      await file.close();
    }

    // No vector database writes occur until every embedding has succeeded.
    stage = 'KNOWLEDGE_INDEX_FAILED';
    indexName = vectorTableName(dimension ?? 0);
    const assigned: { id: string }[] = await database.query(
      `WITH updated AS (UPDATE knowledge_bases
      SET rebuild = jsonb_set(rebuild, '{indexName}', to_jsonb($3::text)) WHERE id=$1 AND rebuild->>'attempt'=$2 AND rebuild->>'status'='processing' RETURNING id) SELECT id FROM updated`,
      [id, attempt, indexName],
    );
    if (!assigned.length) throw new Error('Rebuild superseded');
    await service.store.create(indexName, dimension ?? 0, claimed.fields);
    const input = createReadStream(path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const batch = JSON.parse(line) as VectorBatch;
        await service.store.stage(indexName, batch.chunks, batch.vectors);
        await service.store.materialize(
          indexName,
          claimed.fields,
          batch.chunks,
        );
      }
    } finally {
      lines.close();
      input.destroy();
    }
    const stats = await vectors.describeIndex({ indexName });
    if (
      stats.count !== job.total ||
      (dimension && stats.dimension !== dimension)
    )
      throw new Error('Incomplete vector index');
    await database.transaction(async (m) => {
      const base = await m.findOne(Base, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        base?.rebuild?.attempt !== attempt ||
        base.rebuild.status !== 'processing'
      )
        throw new Error('Rebuild superseded');
      // Only this transaction can publish through the database write guard.
      await m.query("SELECT set_config('knowledge.rebuild_commit', $1, true)", [
        attempt,
      ]);
      if (base.vectorIndex)
        base.retiredIndexes.push({
          name: activeKnowledgeIndex(base),
          after: Date.now() + 60_000,
        });
      Object.assign(base, {
        name: job.name,
        description: job.description,
        enabled: job.enabled,
        embeddingModel: job.embeddingModel,
        rerankModel: job.rerankModel,
        vectorDimension: dimension,
        vectorIndex: indexName,
        rebuild: null,
      });
      await m.save(Base, base);
    });
  } catch (error) {
    // Failure preserves the current model/index; the worker will clean any shadow index.
    await database.transaction(async (m) => {
      const base = await m.findOne(Base, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!base) return;
      if (indexName)
        base.retiredIndexes.push({
          name: indexName,
          after: Date.now() + 60_000,
        });
      if (base.rebuild?.attempt === attempt)
        base.rebuild = {
          ...base.rebuild,
          status: 'failed',
          error: error instanceof ThreadError ? error.code : stage,
        };
      await m.save(Base, base);
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function cleanupKnowledgeIndexes(service: KnowledgeService) {
  const bases = await service.database
    .getRepository(Base)
    .createQueryBuilder('b')
    .where("b.retired_indexes <> '[]'::jsonb")
    .getMany();
  for (const base of bases) {
    for (const entry of base.retiredIndexes) {
      if (
        entry.after > Date.now() ||
        entry.name === base.vectorIndex ||
        (entry.name === base.rebuild?.indexName &&
          base.rebuild.status !== 'failed')
      )
        continue;
      try {
        if ((await service.vectors.listIndexes()).includes(entry.name))
          await service.vectors.deleteIndex({ indexName: entry.name });
        await service.database.query(
          `UPDATE knowledge_bases SET retired_indexes = COALESCE(
          (SELECT jsonb_agg(item) FROM jsonb_array_elements(retired_indexes) item WHERE item->>'name' <> $2), '[]'::jsonb) WHERE id = $1`,
          [base.id, entry.name],
        );
      } catch {
        /* Persisted cleanup entries are retried on the next worker tick. */
      }
    }
  }
}
