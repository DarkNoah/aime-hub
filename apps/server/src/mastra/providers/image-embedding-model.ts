/** Application contract: the AI SDK embedding interface only accepts text. */
export interface ImageEmbeddingModel {
  doEmbedImages(options: {
    images: { data: Uint8Array; mimeType: string }[];
    abortSignal?: AbortSignal;
  }): Promise<{ embeddings: number[][] }>;
}
