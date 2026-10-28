import { createHash } from 'node:crypto';
import { Memory } from '@mastra/memory';
import type { MastraVector } from '@mastra/core/vector';
import { NoSuchModelError } from 'ai';
import type { ProviderService } from '../modules/providers/service.js';
import { ProviderError } from '../modules/providers/network.js';

type MemoryConfig = NonNullable<ConstructorParameters<typeof Memory>[0]>;
export type ChatMemoryConfig = MemoryConfig & { embeddingReference?: string };
export type ResolveMemoryConfig = () => Promise<ChatMemoryConfig>;

// Mastra's default index name only includes the vector dimension. Models with
// equal dimensions still need separate indexes, including direct recall/saves.
export class ChatMemory extends Memory {
  private readonly embeddingReference?: string;

  constructor({ embeddingReference, ...config }: ChatMemoryConfig) {
    super(config);
    this.embeddingReference = embeddingReference;
  }

  protected override getEmbeddingIndexName(dimensions?: number) {
    // Memory calls this without dimensions to discover all message indexes for
    // deletion/update. Keep that shared prefix so old model indexes are cleaned.
    if (!this.embeddingReference || dimensions === undefined)
      return super.getEmbeddingIndexName(dimensions);
    const model = createHash('sha256')
      .update(this.embeddingReference)
      .digest('hex')
      .slice(0, 24);
    return `memory_messages_${model}_${dimensions}`;
  }
}

export async function resolveMemoryConfig(
  providers: Pick<ProviderService, 'getDefaults' | 'getEmbeddingModel'>,
  vector: MastraVector,
): Promise<ChatMemoryConfig> {
  const { embeddingModel: reference } = await providers.getDefaults();
  // Keep the vector store attached for cleanup even after embeddings are disabled.
  const disabled = {
    vector,
    options: { semanticRecall: false },
  } satisfies ChatMemoryConfig;
  // An unset default explicitly disables recall; other enabled models are not
  // permission to turn it back on or select a different embedding space.
  if (!reference) return disabled;

  try {
    const embedder = await providers.getEmbeddingModel(reference);
    return {
      vector,
      // Mastra bundles a separate AI SDK V2 metadata type; both SDK V2/V3
      // embedding contracts are supported at runtime without an adapter.
      embedder: embedder as MemoryConfig['embedder'],
      embeddingReference: reference,
      options: {
        semanticRecall: {
          topK: 3,
          messageRange: 2,
          scope: 'resource',
        },
      },
    } satisfies ChatMemoryConfig;
  } catch (error) {
    // A removed/disabled/unsupported model is unavailable. Database and other
    // unexpected failures must remain visible instead of silently disabling recall.
    if (
      NoSuchModelError.isInstance(error) ||
      (error instanceof ProviderError &&
        ['NOT_FOUND', 'INVALID_MODEL', 'PROVIDER_CONFIG_ONLY'].includes(
          error.code,
        ))
    )
      return disabled;
    throw error;
  }
}
