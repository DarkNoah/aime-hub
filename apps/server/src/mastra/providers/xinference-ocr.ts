import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProviderConfig } from './base-provider.js';
import type { OcrModel } from './ocr-model.js';
import { requestWebResource, webUrl } from '../web/request.js';

const maxFileBytes = 200 * 1024 * 1024;
const pageSchema = z.object({ markdown: z.string() });
const responseSchema = z.union([pageSchema, z.array(pageSchema)]);

/** Multipart document parsing used by Xinference OCR services. */
export function createDocumentOcrModel(
  provider: ProviderConfig,
  modelId: string,
  request = requestWebResource,
): OcrModel {
  if (!modelId.trim()) throw new Error('Xinference OCR model ID is required');
  const endpoint = `${provider.baseUrl.replace(/\/+$/, '')}/documents/parse`;
  return {
    provider: 'xinference',
    modelId,
    supportsPageRanges: false,
    async doOCR(options) {
      const signal = AbortSignal.any([
        AbortSignal.timeout(provider.timeoutMs ?? 600_000),
        ...(options.abortSignal ? [options.abortSignal] : []),
      ]);
      signal.throwIfAborted();
      if (
        options.pageRanges !== undefined ||
        options.language !== undefined ||
        options.forceOcr !== undefined ||
        options.enableFormula !== undefined ||
        options.enableTable !== undefined
      )
        throw new Error(
          'Xinference document parsing does not support these OCR options',
        );
      const settings = z
        .object({ response_format: z.enum(['json', 'md']).optional() })
        .strict()
        .parse(options.providerOptions ?? {});
      const format = z
        .enum(['json', 'md'])
        .parse(options.responseFormat ?? settings.response_format ?? 'md');
      let data: Uint8Array;
      let fileName: string;
      if (options.input.url !== undefined) {
        const source = webUrl(options.input.url);
        // Use the shared network policy; never send provider credentials to file URLs.
        const response = await request(source.href, {
          signal,
          maxBytes: maxFileBytes,
        });
        signal.throwIfAborted();
        if (response.status !== 200)
          throw new Error(`OCR file download failed (${response.status})`);
        data = response.body;
        fileName = decodeURIComponent(
          source.pathname.split('/').pop() || 'document',
        );
      } else {
        ({ data, fileName } = options.input);
      }
      if (
        !(data instanceof Uint8Array) ||
        !data.byteLength ||
        data.byteLength > maxFileBytes
      )
        throw new Error(
          'Xinference OCR requires a non-empty file of at most 200 MB',
        );
      if (!fileName || /[/\\\x00-\x1f\x7f]/.test(fileName))
        throw new Error('Invalid OCR file name');
      const form = new FormData();
      // This endpoint uses the deployed OCR model and accepts only response_format.
      // Sending a model field is rejected by the service's multipart field limit.
      form.set('response_format', format);
      form.set('file', new Blob([new Uint8Array(data)]), fileName);
      const encoded = new Request(endpoint, { method: 'POST', body: form });
      const body = Buffer.from(await encoded.arrayBuffer());
      signal.throwIfAborted();
      const response = await request(endpoint, {
        method: 'POST',
        signal,
        body,
        maxBytes: 20 * 1024 * 1024,
        headers: {
          ...(provider.apiKey
            ? { authorization: `Bearer ${provider.apiKey}` }
            : {}),
          'content-type': encoded.headers.get('content-type')!,
        },
      });
      signal.throwIfAborted();
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Xinference OCR request failed (${response.status})`);
      const text = response.body.toString('utf8');
      const taskId = randomUUID();
      if (format === 'md') {
        if (response.headers['content-type']?.includes('application/json'))
          throw new Error('Xinference OCR returned JSON instead of Markdown');
        return { markdown: text, taskId };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('Invalid Xinference OCR JSON response');
      }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error('Invalid Xinference OCR document response');
      const pages = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      return {
        markdown: pages.map((page) => page.markdown).join('\n\n'),
        data: raw,
        taskId,
      };
    },
  };
}
