import type { SpeechModel } from 'ai';
import { speechFormats } from '@aime/shared/audio';
import { z } from 'zod';
import type { ProviderConfig } from './base-provider.js';
import {
  requestWebResource,
  streamWebResource,
  webUrl,
} from '../web/request.js';
import { allowAllNetworks } from '../../modules/network/policy.js';
import type {
  ReferenceSpeechModel,
  SpeechModelSettings,
  SpeechProviderOptions,
  StreamingSpeechModel,
} from './speech-model.js';

const referenceOptions = z.object({
  reference_audio: z.string().optional(),
  reference_text: z.string().optional(),
});

/** Standard speech generation; PCM streaming is an explicit provider capability. */
export function createSpeechModel(
  provider: ProviderConfig & { type: string },
  modelId: string,
  settings: SpeechModelSettings = {},
  request = requestWebResource,
  streamRequest = streamWebResource,
): SpeechModel {
  const streaming = settings.metadata?.speechStreaming === true;
  const defaultVoice =
    typeof settings.metadata?.speechDefaultVoice === 'string'
      ? settings.metadata.speechDefaultVoice
      : undefined;
  const url = webUrl(provider.baseUrl);
  if (
    (!allowAllNetworks() && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    !modelId.trim()
  )
    throw new Error('Invalid speech provider configuration');
  const endpoint = `${url.href.replace(/\/+$/, '')}/audio/speech`;
  const headers = {
    'content-type': 'application/json',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
  };
  const signalFor = (signal?: AbortSignal) =>
    AbortSignal.any([
      AbortSignal.timeout(provider.timeoutMs ?? 300000),
      ...(signal ? [signal] : []),
    ]);
  const voiceBody = (
    voice?: string,
    providerOptions?: SpeechProviderOptions,
  ) => {
    const reference = referenceOptions.parse(
      providerOptions?.[provider.type] ?? {},
    );
    return {
      voice: reference.reference_audio ? undefined : voice || defaultVoice,
      ...reference,
    };
  };
  const model: ReferenceSpeechModel = {
    specificationVersion: 'v3',
    provider: provider.type,
    modelId,
    supportsReferenceAudio: true,
    doGenerate: async ({
      text,
      voice,
      instructions,
      speed,
      outputFormat,
      abortSignal,
      providerOptions,
    }) => {
      const signal = signalFor(abortSignal);
      const format = z.enum(speechFormats).parse(outputFormat ?? 'wav');
      const response = await request(endpoint, {
        method: 'POST',
        headers,
        signal,
        maxBytes: 50_000_000,
        body: JSON.stringify({
          model: modelId,
          input: text,
          ...voiceBody(voice, providerOptions),
          instructions,
          speed,
          response_format: format,
          ...(streaming ? { stream: false } : {}),
        }),
      });
      signal.throwIfAborted();
      if (
        response.status !== 200 ||
        !response.body.length ||
        !/^(audio\/|application\/octet-stream)/i.test(
          response.headers['content-type'] ?? '',
        )
      )
        throw new Error('Invalid speech provider response');
      return {
        audio: response.body,
        warnings: [],
        response: { timestamp: new Date(), modelId, headers: response.headers },
      };
    },
  };
  if (!streaming) return model;
  const result: StreamingSpeechModel = {
    ...model,
    streamSpeech: async (
      { text, voice, instructions, speed, abortSignal, providerOptions },
      onChunk,
    ) => {
      const signal = signalFor(abortSignal);
      await streamRequest(
        endpoint,
        {
          method: 'POST',
          headers,
          signal,
          maxBytes: 50_000_000,
          body: JSON.stringify({
            model: modelId,
            input: text,
            ...voiceBody(voice, providerOptions),
            instructions,
            speed,
            response_format: 'pcm',
            stream: true,
          }),
        },
        {
          response: ({ status, headers }) => {
            if (
              status !== 200 ||
              !/^(audio\/pcm|application\/octet-stream)(;|$)/i.test(
                headers['content-type'] ?? '',
              )
            )
              throw new Error('Invalid streaming speech response');
          },
          chunk: (data) =>
            onChunk({
              data,
              encoding: 'pcm_s16le',
              mimeType: 'audio/pcm',
              sampleRate: 24000,
              channels: 1,
            }),
        },
      );
    },
  };
  return result;
}
