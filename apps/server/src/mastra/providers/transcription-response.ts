import { z } from 'zod';
import { transcriptionFormats } from '@aime/shared/audio';

export const transcriptionResponseFormatSchema = z.enum(transcriptionFormats);
export type TranscriptionResponseFormat = z.infer<
  typeof transcriptionResponseFormatSchema
>;

// Keep provider fields such as task, usage, words, logprobs and segment metadata.
// Do not replace OpenAI's start/end with the AI SDK's startSecond/endSecond.
export const transcriptionJsonResponseSchema = z.looseObject({
  text: z.string(),
  language: z.string().nullish(),
  duration: z.number().nonnegative().nullish(),
  segments: z
    .array(
      z.looseObject({
        text: z.string(),
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
      }),
    )
    .nullish(),
});
export const transcriptionResponseSchema = z.union([
  transcriptionJsonResponseSchema,
  z.string(),
]);

export function parseTranscriptionResponse(
  response: unknown,
  format: TranscriptionResponseFormat,
) {
  if (format !== 'json' && format !== 'verbose_json') {
    if (typeof response !== 'string')
      throw new Error(
        'The ASR provider did not return the requested text format.',
      );
    return response;
  }
  const data = transcriptionJsonResponseSchema.parse(response);
  if (
    format === 'verbose_json' &&
    (typeof data.language !== 'string' || typeof data.duration !== 'number')
  )
    throw new Error(
      'The ASR provider did not return a verbose JSON transcription.',
    );
  return data;
}
