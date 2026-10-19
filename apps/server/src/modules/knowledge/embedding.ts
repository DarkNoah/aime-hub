import { embedMany } from 'ai';
import { withAbortSignal } from '../../lib/abort.js';
import type { ProviderService } from '../providers/service.js';
import { ThreadError } from '../threads/errors.js';
import { validateKnowledgeFile } from './parse.js';
import type { StoredChunk } from './vector-store.js';

type Providers = Pick<
  ProviderService,
  'getEmbeddingModel' | 'getImageEmbeddingModel'
>;

/** Keep image bytes on the image path, including when rebuilding mixed corpora. */
export function createKnowledgeEmbedder(
  providers: Providers,
  reference: string | null,
  maxRetries = 0,
) {
  let textModel: ReturnType<Providers['getEmbeddingModel']> | undefined;
  let imageModel: ReturnType<Providers['getImageEmbeddingModel']> | undefined;
  return async (
    chunks: Pick<StoredChunk, 'documentId' | 'text' | 'inputType'>[],
    loadImage: (documentId: string) => Promise<{ name: string; data: Buffer }>,
  ): Promise<number[][] | null> => {
    const hasImages = chunks.some((chunk) => chunk.inputType === 'image');
    if (!reference) {
      if (hasImages)
        throw new ThreadError('KNOWLEDGE_IMAGE_MODEL_REQUIRED', 400);
      return null;
    }
    const signal = AbortSignal.timeout(180_000);
    return withAbortSignal(signal, async () => {
      const vectors: number[][] = new Array(chunks.length);
      const textIndexes = chunks.flatMap((chunk, i) =>
        chunk.inputType === 'image' ? [] : [i],
      );
      for (let i = 0; i < textIndexes.length; i += 32) {
        const indexes = textIndexes.slice(i, i + 32);
        textModel ??= providers.getEmbeddingModel(reference);
        const model = await textModel;
        signal.throwIfAborted();
        const result = await embedMany({
          model,
          values: indexes.map((index) => chunks[index]!.text),
          maxParallelCalls: 2,
          maxRetries,
          abortSignal: signal,
        });
        if (result.embeddings.length !== indexes.length)
          throw new Error('Invalid embeddings');
        indexes.forEach((index, j) => {
          vectors[index] = result.embeddings[j]!;
        });
      }
      for (const [index, chunk] of chunks.entries()) {
        signal.throwIfAborted();
        if (chunk.inputType !== 'image') continue;
        imageModel ??= providers.getImageEmbeddingModel(reference);
        const model = await imageModel;
        if (!model)
          throw new ThreadError('KNOWLEDGE_IMAGE_MODEL_REQUIRED', 400);
        const image = await loadImage(chunk.documentId);
        signal.throwIfAborted();
        const info = validateKnowledgeFile(image.name, image.data);
        if (!info) throw new ThreadError('KNOWLEDGE_FILE_TYPE', 400);
        try {
          const result = await model.doEmbedImages({
            images: [{ data: image.data, mimeType: info.mimeType }],
            abortSignal: signal,
          });
          if (result.embeddings.length !== 1)
            throw new Error('Invalid image embeddings');
          vectors[index] = result.embeddings[0]!;
        } catch {
          throw new ThreadError('KNOWLEDGE_IMAGE_EMBED_FAILED');
        }
      }
      const dimension = vectors[0]?.length;
      if (
        !dimension ||
        vectors.some(
          (v) =>
            !v || v.length !== dimension || v.some((n) => !Number.isFinite(n)),
        )
      )
        throw new Error('Invalid embeddings');
      return vectors;
    });
  };
}
