import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  defaultTranscribeConfig,
  type TranscribeConfig,
} from '@aime/shared/tools';
import type { AudioService } from '../../modules/audio/service.js';
import { normalizeVoiceAudio } from '../../modules/audio/convert.js';
import { readAudioReference } from './audio/context.js';
import { wavMetadata } from '../providers/audio-data.js';

export function createTranscribeTool(
  config: TranscribeConfig = defaultTranscribeConfig,
  audio?: AudioService,
) {
  return createTool({
    id: 'transcribe',
    description:
      'Recognize speech from an audio file. Accepts a conversation workspace path, a voice audioPath from list_voices, or a public HTTP(S) URL. Returns the original-language transcript and timestamps when supported. Uses the configured speech-recognition model.',
    inputSchema: z.object({
      audio: z.string().describe('Audio file path or public URL'),
      language: z
        .string()
        .optional()
        .describe('Optional language hint, e.g. zh or en'),
      prompt: z
        .string()
        .optional()
        .describe('Optional vocabulary or context for recognition'),
    }),
    outputSchema: z.object({
      text: z.string(),
      duration: z.number(),
      segments: z
        .array(
          z.object({
            text: z.string(),
            startSecond: z.number(),
            endSecond: z.number(),
          }),
        )
        .optional(),
    }),
    execute: async (input, context) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(config.timeoutMs),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      try {
        if (!audio) throw new Error('Audio service unavailable');
        const reference = await readAudioReference(input.audio, context, {
          voices: audio.voices,
          signal,
        });
        const bytes = await normalizeVoiceAudio(reference.audio, signal);
        const result = await audio.transcribe(bytes, {
          ...input,
          model: config.model ?? undefined,
          signal,
        });
        return {
          text: result.text,
          duration: wavMetadata(bytes).duration,
          ...(result.segments?.length ? { segments: result.segments } : {}),
        };
      } catch {
        const text = signal.aborted
          ? 'Speech recognition was cancelled or timed out.'
          : 'Speech recognition failed. Check the audio path and the configured ASR model.';
        throw new Error(text);
      }
    },
    toModelOutput: (output) => ({
      type: 'text',
      value: JSON.stringify(output),
    }),
  });
}
export const transcribe = createTranscribeTool();
