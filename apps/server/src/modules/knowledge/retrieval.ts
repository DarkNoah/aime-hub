import { tmpdir } from 'node:os';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { rerankWithScorer } from '@mastra/rag';
import { rerank, type RerankingModel } from 'ai';
import type { KnowledgeHit } from '@aime/shared/knowledge';

export type RankedChunk = { id: string; score: number };
export const KNOWLEDGE_RERANK_TIMEOUT_MS = 60_000;
const reciprocalRankScore = (zeroBasedRank: number) =>
  1 / (60 + zeroBasedRank + 1);
export type FusedChunk = {
  id: string;
  score: number;
  mode: 'vector' | 'bm25' | 'hybrid';
  scores: { rrf: number; vector?: number; bm25?: number };
};

// Keep Latin words intact; CJK unigrams and bigrams also match unspaced queries.
export function tokenizeKnowledge(text: string): string[] {
  const runs =
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(
        /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/gu,
        ' $1 ',
      )
      .match(/[\p{L}\p{N}_]+/gu) ?? [];
  return runs.flatMap((run) => {
    if (
      !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        run,
      )
    )
      return [run];
    const chars = [...run];
    return [...chars, ...chars.slice(1).map((char, i) => chars[i]! + char)];
  });
}

export async function searchBM25(
  chunks: AsyncIterable<{ id: string; text: string }>,
  query: string,
  topK: number,
): Promise<RankedChunk[]> {
  // Request-local index: only the authorized, enabled corpus contributes to IDF.
  // Workspace requires a provider. This read-only adapter is never initialized
  // or read: only explicit database chunks are indexed, with no autoIndexPaths.
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: tmpdir(), readOnly: true }),
    bm25: { tokenize: { tokenizer: tokenizeKnowledge } },
  });
  try {
    for await (const chunk of chunks)
      await workspace.index(chunk.id, chunk.text);
    return (await workspace.search(query, { mode: 'bm25', topK })).map(
      ({ id, score }) => ({ id, score }),
    );
  } finally {
    await workspace.destroy();
  }
}

export function fuseRanks(
  lists: { mode: 'vector' | 'bm25'; hits: RankedChunk[] }[],
): FusedChunk[] {
  const fused = new Map<string, FusedChunk>();
  for (const { mode, hits } of lists) {
    const seen = new Set<string>();
    for (const [rank, hit] of hits.entries()) {
      if (seen.has(hit.id) || !Number.isFinite(hit.score)) continue;
      seen.add(hit.id);
      const result = fused.get(hit.id) ?? {
        id: hit.id,
        score: 0,
        mode,
        scores: { rrf: 0 },
      };
      result.scores[mode] = hit.score;
      result.score += reciprocalRankScore(rank);
      result.scores.rrf = result.score;
      if (
        result.scores.vector !== undefined &&
        result.scores.bm25 !== undefined
      )
        result.mode = 'hybrid';
      fused.set(hit.id, result);
    }
  }
  return [...fused.values()].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}

export function mergeVectorRanks(
  lists: {
    embeddingModel: string | null;
    vectorDimension: number | null;
    hits: RankedChunk[];
  }[],
  topK: number,
): { mode: 'vector'; hits: RankedChunk[] }[] {
  // Cosine scores are comparable across indexes using the same embedding space.
  // Rank their union once, so every knowledge base does not get a separate #1.
  const groups = new Map<string, Map<string, RankedChunk>>();
  for (const { embeddingModel, vectorDimension, hits } of lists) {
    if (!embeddingModel || !vectorDimension) continue;
    const key = JSON.stringify([embeddingModel, vectorDimension]);
    const group = groups.get(key) ?? new Map<string, RankedChunk>();
    for (const hit of hits) {
      if (!Number.isFinite(hit.score)) continue;
      const previous = group.get(hit.id);
      if (!previous || hit.score > previous.score) group.set(hit.id, hit);
    }
    groups.set(key, group);
  }
  // Different embedding spaces remain separate recall routes. Their raw scores
  // must not be compared; the shared reranker decides the final cross-base order.
  return [...groups.values()].map((group) => ({
    mode: 'vector',
    hits: [...group.values()]
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK),
  }));
}

// Bound the whole model/index stage, including clients that ignore AbortSignal.
export async function withSearchTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  milliseconds = 10_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('KNOWLEDGE_SEARCH_TIMEOUT'));
        }, milliseconds);
      }),
      run(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function rerankKnowledge(
  hits: KnowledgeHit[],
  query: string,
  model: RerankingModel,
  signal: AbortSignal,
): Promise<KnowledgeHit[]> {
  // One provider batch, adapted to Mastra's per-passage RelevanceScoreProvider.
  signal.throwIfAborted();
  const documents = [...new Set(hits.map((hit) => hit.text))];
  const { ranking } = await rerank({
    model,
    query,
    documents,
    topN: documents.length,
    maxRetries: 0,
    abortSignal: signal,
  });
  const scores = new Map<string, number>();
  const indexes = new Set<number>();
  for (const item of ranking) {
    const text = documents[item.originalIndex];
    if (
      text === undefined ||
      !Number.isInteger(item.originalIndex) ||
      indexes.has(item.originalIndex) ||
      !Number.isFinite(item.score)
    )
      throw new Error('KNOWLEDGE_RERANK_INVALID');
    indexes.add(item.originalIndex);
    scores.set(text, item.score);
  }
  if (scores.size !== documents.length)
    throw new Error('KNOWLEDGE_RERANK_INVALID');
  const results = await rerankWithScorer({
    results: hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      metadata: { text: hit.text },
    })),
    query,
    scorer: { getRelevanceScore: async (_query, text) => scores.get(text)! },
    // Rerank scores may be negative or exceed 1. They determine final order;
    // recall RRF is retained only for diagnostics and failure fallback.
    options: {
      topK: hits.length,
      weights: { semantic: 1, vector: 0, position: 0 },
    },
  });
  const byId = new Map(hits.map((hit) => [hit.id, hit]));
  return results.map(({ result, score }) => {
    const hit = byId.get(result.id)!;
    return {
      ...hit,
      score,
      scores: { rrf: hit.score, ...hit.scores, rerank: score },
    };
  });
}

export function rerankFailureReason(error: unknown) {
  if (
    error instanceof Error &&
    error.message === 'KNOWLEDGE_RERANK_MODEL_CONFLICT'
  )
    return 'model_conflict' as const;
  if (
    error instanceof Error &&
    (error.message === 'KNOWLEDGE_SEARCH_TIMEOUT' ||
      error.name === 'TimeoutError')
  )
    return 'timeout' as const;
  if (
    error instanceof Error &&
    (error.message === 'KNOWLEDGE_RERANK_INVALID' ||
      error.name === 'AI_InvalidResponseDataError')
  )
    return 'invalid_response' as const;
  return 'failed' as const;
}
