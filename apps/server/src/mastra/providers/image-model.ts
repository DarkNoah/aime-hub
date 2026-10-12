import type { ImageModel } from 'ai';
import { z } from 'zod';
import type { ProviderConfig } from './base-provider.js';
import { imageBase64, imageMimeType, maxImageBytes } from './image-data.js';
import { requestWebResource, webUrl } from '../web/request.js';

const responseSchema = z.object({
  data: z
    .array(
      z.object({ b64_json: z.string().optional(), url: z.string().optional() }),
    )
    .min(1)
    .max(1),
});

/** OpenAI Images protocol, shared by compatible providers and New API. */
export function createImageModel(
  provider: ProviderConfig,
  modelId: string,
  request = requestWebResource,
): Exclude<ImageModel, string | { specificationVersion: 'v2' }> {
  const url = webUrl(provider.baseUrl);
  if (url.protocol !== 'https:' || url.search || url.hash || !modelId.trim())
    throw new Error('Invalid image provider configuration');
  const baseUrl = url.href.replace(/\/+$/, '');
  return {
    specificationVersion: 'v3',
    provider: provider.id,
    modelId,
    maxImagesPerCall: 1,
    doGenerate: async ({
      prompt,
      n,
      files,
      mask,
      size,
      aspectRatio,
      seed,
      providerOptions,
      abortSignal,
    }) => {
      if (mask || aspectRatio || seed !== undefined)
        throw new Error('Unsupported image options');
      const signal = AbortSignal.any([
        AbortSignal.timeout(provider.timeoutMs ?? 600000),
        ...(abortSignal ? [abortSignal] : []),
      ]);
      signal.throwIfAborted();
      const background = z
        .enum(['transparent', 'opaque', 'auto'])
        .optional()
        .parse(providerOptions?.openai?.background);
      const fields = {
        model: modelId,
        prompt,
        n,
        size,
        ...(background ? { background, output_format: 'png' } : {}),
        // GPT Image always returns base64 and does not accept response_format.
        ...(modelId.startsWith('dall-e-')
          ? { response_format: 'b64_json' }
          : {}),
      };
      const headers: Record<string, string> = {};
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      let body: string | Buffer;
      if (files?.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields))
          if (value !== undefined) form.set(key, String(value));
        for (const [index, file] of files.entries()) {
          if (file.type !== 'file')
            throw new Error(
              'Reference images must be loaded before generation',
            );
          const data =
            typeof file.data === 'string' ? imageBase64(file.data) : file.data;
          const type = imageMimeType(data);
          form.append(
            files.length === 1 ? 'image' : 'image[]',
            new Blob([new Uint8Array(data)], { type }),
            `reference-${index}.${type.split('/')[1]}`,
          );
        }
        const encoded = new Request(`${baseUrl}/images/edits`, {
          method: 'POST',
          body: form,
        });
        headers['content-type'] = encoded.headers.get('content-type')!;
        body = Buffer.from(await encoded.arrayBuffer());
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(fields);
      }
      const response = await request(
        `${baseUrl}/images/${files?.length ? 'edits' : 'generations'}`,
        {
          method: 'POST',
          signal,
          headers,
          body,
          maxBytes: 30_000_000,
        },
      );
      signal.throwIfAborted();
      if (response.status !== 200)
        throw new Error('Image provider request failed');
      const parsed = responseSchema.parse(
        JSON.parse(response.body.toString('utf8')),
      );
      const images: Uint8Array[] = [];
      for (const item of parsed.data) {
        if (item.b64_json) images.push(imageBase64(item.b64_json));
        else if (item.url) {
          // Signed image URLs get no provider credentials; redirects stay disabled.
          const image = await request(item.url, {
            signal,
            maxBytes: maxImageBytes,
          });
          if (image.status !== 200) throw new Error('Image download failed');
          imageMimeType(image.body);
          images.push(image.body);
        } else throw new Error('Image provider returned no image');
      }
      signal.throwIfAborted();
      return {
        images,
        warnings: [],
        response: { timestamp: new Date(), modelId, headers: response.headers },
      };
    },
  };
}
