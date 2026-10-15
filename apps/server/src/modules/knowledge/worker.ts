import { randomUUID } from 'node:crypto';
import { embedMany } from 'ai';
import {
  KnowledgeBaseRecord as Base,
  KnowledgeDocumentRecord as Document,
} from '@aime/db';
import { In } from 'typeorm';
import { ThreadError } from '../threads/errors.js';
import { parseKnowledgeSource } from './parse.js';
import type { StoredChunk } from './vector-store.js';
import { activeKnowledgeIndex, type KnowledgeService } from './service.js';
import { knowledgeLocked } from '@aime/shared/knowledge';
import { cleanupKnowledgeIndexes, rebuildKnowledge } from './rebuild.js';

// A PostgreSQL session lock permits one importer across processes. Losing the
// session releases the lock; the next worker reclaims persisted processing rows.
export class KnowledgeWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private service: KnowledgeService) {}
  start() {
    this.timer = setInterval(() => this.wake(), 2000);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.stopped || this.running) return;
    this.running = this.drain()
      .catch((error: unknown) => {
        console.error(
          'Knowledge worker unavailable',
          error instanceof Error ? error.name : 'UnknownError',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
  async drain() {
    const { database } = this.service;
    const lock = database.createQueryRunner();
    await lock.connect();
    let acquired = false;
    try {
      const rows = await lock.query(
        "SELECT pg_try_advisory_lock(hashtext('knowledge-import-worker'), hashtext(current_schema())) AS acquired",
      );
      acquired = rows[0].acquired;
      if (!acquired) return;
      await cleanupKnowledgeIndexes(this.service);
      for (let n = 0; n < 5 && !this.stopped; n++) {
        const rebuilding = await database
          .getRepository(Base)
          .createQueryBuilder('b')
          .where("b.rebuild->>'status' IN ('pending', 'processing')")
          .orderBy('b.created_at', 'ASC')
          .getOne();
        if (rebuilding) {
          await rebuildKnowledge(this.service, rebuilding.id);
          continue;
        }
        const next = await database.manager.findOne(Document, {
          where: { status: In(['pending', 'processing']) },
          order: { createdAt: 'ASC' },
        });
        if (!next) break;
        const claimed = await database.transaction(async (m) => {
          const base = await m.findOne(Base, {
            where: { id: next.baseId },
            lock: { mode: 'pessimistic_write' },
          });
          if (!base || knowledgeLocked(base)) return null;
          const doc = await m
            .getRepository(Document)
            .createQueryBuilder('d')
            .addSelect('d.sourceData')
            .where('d.id = :id', { id: next.id })
            .getOne();
          if (!doc || !['pending', 'processing'].includes(doc.status))
            return null;
          await m.update(Document, doc.id, {
            status: 'processing',
            error: null,
          });
          return { base, doc };
        });
        if (claimed) await this.process(claimed.base, claimed.doc);
      }
    } finally {
      try {
        if (acquired)
          await lock.query(
            "SELECT pg_advisory_unlock(hashtext('knowledge-import-worker'), hashtext(current_schema()))",
          );
      } finally {
        await lock.release();
      }
    }
  }
  private async process(base: Base, doc: Document) {
    const { database, providers } = this.service;
    let stage = 'KNOWLEDGE_PARSE_FAILED';
    let parsedContent: string | undefined;
    let staged: string[] = [];
    const indexName = activeKnowledgeIndex(base);
    try {
      const { content, texts } = await parseKnowledgeSource(doc);
      parsedContent = content;
      const chunks: StoredChunk[] = texts.map((text, position) => ({
        id: randomUUID(),
        documentId: doc.id,
        position,
        text,
        version: doc.version,
        attributes: doc.metadata,
        name: doc.name,
        sourceUrl: doc.sourceUrl,
      }));
      let embeddings: number[][] | null = null;
      if (base.embeddingModel) {
        stage = 'KNOWLEDGE_EMBED_FAILED';
        const model = await providers.getEmbeddingModel(base.embeddingModel);
        embeddings = [];
        const signal = AbortSignal.timeout(180_000);
        for (let i = 0; i < texts.length; i += 32) {
          const batch = await embedMany({
            model,
            values: texts.slice(i, i + 32),
            maxParallelCalls: 2,
            abortSignal: signal,
            maxRetries: 1,
          });
          embeddings.push(...batch.embeddings);
        }
        const dimension = embeddings[0]?.length;
        if (
          !dimension ||
          embeddings.length !== chunks.length ||
          embeddings.some(
            (e) => e.length !== dimension || e.some((v) => !Number.isFinite(v)),
          )
        )
          throw new Error('Invalid embeddings');
        if (base.vectorDimension && base.vectorDimension !== dimension)
          throw new ThreadError('KNOWLEDGE_DIMENSION_CHANGED');
      }
      stage = 'KNOWLEDGE_INDEX_FAILED';
      staged = chunks.map((c) => c.id);
      for (let i = 0; i < chunks.length; i += 64)
        await this.service.store.stage(
          indexName,
          chunks.slice(i, i + 64),
          embeddings?.slice(i, i + 64) ?? null,
        );
      await database.transaction(async (m) => {
        await this.service.store.materialize(indexName, base.fields, chunks, m);
        await m.query(
          `DELETE FROM ${this.service.store.table(indexName)} WHERE metadata->>'documentId'=$1 AND NOT(vector_id = ANY($2::text[]))`,
          [doc.id, staged],
        );
        await m.update(Document, doc.id, {
          content,
          status: 'ready',
          chunkCount: chunks.length,
          error: null,
        });
      });
    } catch (error) {
      if (staged.length)
        await this.service.vectors
          .deleteVectors({ indexName, ids: staged })
          .catch(() => {});
      // Never persist raw provider responses, credentials or local parser paths.
      await database.manager.update(Document, doc.id, {
        ...(parsedContent !== undefined ? { content: parsedContent } : {}),
        status: 'failed',
        error: error instanceof ThreadError ? error.code : stage,
      });
    }
  }
}
