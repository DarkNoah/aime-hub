import type { TranscriptionModel } from 'ai';
import { z } from 'zod';
import type { ProviderConfig } from './base-provider.js';
import { requestWebResource, webUrl } from '../web/request.js';
import { allowAllNetworks } from '../../modules/network/policy.js';
import {
  parseTranscriptionResponse,
  transcriptionResponseFormatSchema,
} from './transcription-response.js';

const transcriptionOptions = z.object({
  language: z.string().optional(),
  prompt: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  response_format: transcriptionResponseFormatSchema.default('json'),
});
const audioExtensions: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/aac': 'aac',
};

/** OpenAI-compatible multipart transcription, including tudao's Qwen ASR. */
export function createTranscriptionModel(
  provider: ProviderConfig & { type: string },
  modelId: string,
  request = requestWebResource,
): TranscriptionModel {
  const url = webUrl(provider.baseUrl);
  if (
    (!allowAllNetworks() && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    !modelId.trim()
  )
    throw new Error('Invalid transcription provider configuration');
  const endpoint = `${url.href.replace(/\/+$/, '')}/audio/transcriptions`;
  return {
    specificationVersion: 'v3',
    provider: provider.type,
    modelId,
    doGenerate: async ({
      audio,
      mediaType,
      providerOptions,
      abortSignal,
      headers: extraHeaders,
    }) => {
      // A tool-supplied signal already includes its configured timeout. Do not
      // silently shorten long transcription jobs to the standalone default.
      const signal =
        provider.timeoutMs === undefined
          ? (abortSignal ?? AbortSignal.timeout(300_000))
          : AbortSignal.any([
              AbortSignal.timeout(provider.timeoutMs),
              ...(abortSignal ? [abortSignal] : []),
            ]);
      signal.throwIfAborted();
      const options = transcriptionOptions.parse(
        providerOptions?.[provider.type] ?? {},
      );
      const bytes =
        typeof audio === 'string' ? Buffer.from(audio, 'base64') : audio;
      if (!bytes.length) throw new Error('Transcription audio is required');
      const mimeType = mediaType.split(';')[0].trim().toLowerCase();
      const form = new FormData();
      form.set('model', modelId);
      form.set(
        'file',
        new Blob([new Uint8Array(bytes)], { type: mimeType }),
        `audio.${audioExtensions[mimeType] ?? 'bin'}`,
      );
      for (const [key, value] of Object.entries(options))
        if (value !== undefined) form.set(key, String(value));
      const encoded = new Request(endpoint, { method: 'POST', body: form });
      const body = Buffer.from(await encoded.arrayBuffer());
      signal.throwIfAborted();
      const headers = new Headers();
      for (const [key, value] of Object.entries(extraHeaders ?? {}))
        if (value !== undefined) headers.set(key, value);
      if (provider.apiKey)
        headers.set('authorization', `Bearer ${provider.apiKey}`);
      headers.set('content-type', encoded.headers.get('content-type')!);
      const timestamp = new Date();
      const response = await request(endpoint, {
        method: 'POST',
        signal,
        headers: Object.fromEntries(headers),
        body,
        maxBytes: Infinity,
      });
      signal.throwIfAborted();
      if (response.status !== 200)
        throw new Error(`Transcription request failed (${response.status})`);
      const json =
        options.response_format === 'json' ||
        options.response_format === 'verbose_json';
      if (
        !json &&
        response.headers['content-type']?.includes('application/json')
      )
        throw new Error(
          'The ASR provider returned JSON instead of the requested text format.',
        );
      let raw: unknown;
      let data: ReturnType<typeof parseTranscriptionResponse>;
      try {
        raw = json
          ? JSON.parse(response.body.toString('utf8'))
          : response.body.toString('utf8');
        data = parseTranscriptionResponse(raw, options.response_format);
      } catch {
        throw new Error('Invalid transcription response');
      }
      const details = typeof data === 'string' ? undefined : data;
      return {
        text: typeof data === 'string' ? data : data.text,
        segments:
          details?.segments?.map(({ text, start, end }) => ({
            text,
            startSecond: start,
            endSecond: end,
          })) ?? [],
        language:
          details?.language && /^[a-z]{2}$/i.test(details.language)
            ? details.language.toLowerCase()
            : undefined,
        // Billing usage.seconds can be rounded; only duration is an audio duration.
        durationInSeconds: details?.duration ?? undefined,
        warnings: [],
        response: { timestamp, modelId, headers: response.headers, body: raw },
      };
    },
  };
}
