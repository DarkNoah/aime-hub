import type { TranscriptionModel } from 'ai';
import { z } from 'zod';
import type { ProviderConfig } from './base-provider.js';
import { requestWebResource, webUrl } from '../web/request.js';
import { allowAllNetworks } from '../../modules/network/policy.js';

const transcriptionOptions = z.object({
  language: z.string().optional(),
  prompt: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
});
const responseSchema = z.object({
  text: z.string(),
  language: z.string().nullish(),
  duration: z.number().nonnegative().nullish(),
  segments: z
    .array(
      z.object({
        text: z.string(),
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
      }),
    )
    .nullish(),
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
      const signal = AbortSignal.any([
        AbortSignal.timeout(provider.timeoutMs ?? 300_000),
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
      // tudao returns text JSON; it does not require verbose JSON or timestamps.
      form.set('response_format', 'json');
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
        maxBytes: 20_000_000,
      });
      signal.throwIfAborted();
      if (response.status !== 200)
        throw new Error(`Transcription request failed (${response.status})`);
      let raw: unknown;
      try {
        raw = JSON.parse(response.body.toString('utf8'));
      } catch {
        throw new Error('Invalid transcription JSON response');
      }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new Error('Invalid transcription response');
      const data = parsed.data;
      return {
        text: data.text,
        segments:
          data.segments?.map(({ text, start, end }) => ({
            text,
            startSecond: start,
            endSecond: end,
          })) ?? [],
        language:
          data.language && /^[a-z]{2}$/i.test(data.language)
            ? data.language.toLowerCase()
            : undefined,
        // Billing usage.seconds can be rounded; only duration is an audio duration.
        durationInSeconds: data.duration ?? undefined,
        warnings: [],
        response: { timestamp, modelId, headers: response.headers, body: raw },
      };
    },
  };
}
