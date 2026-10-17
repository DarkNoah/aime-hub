import type { SpeechModel } from 'ai';

export type SpeechAudioChunk = {
  data: Uint8Array;
  encoding: 'pcm_s16le' | 'file';
  mimeType: string;
  sampleRate?: number;
  channels?: number;
};
export type SpeechStreamOptions = {
  text: string;
  voice?: string;
  instructions?: string;
  speed?: number;
  abortSignal: AbortSignal;
};
export type StreamingSpeechModel = Exclude<SpeechModel, string> & {
  streamSpeech: (
    options: SpeechStreamOptions,
    onChunk: (chunk: SpeechAudioChunk) => Promise<void>,
  ) => Promise<void>;
};
export function supportsSpeechStreaming(
  model: SpeechModel,
): model is StreamingSpeechModel {
  return (
    typeof model !== 'string' &&
    'streamSpeech' in model &&
    typeof model.streamSpeech === 'function'
  );
}

export type SpeechModelSettings = {
  modelName?: string;
  metadata?: Record<string, unknown>;
};
