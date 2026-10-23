import { BuiltinTool, type ToolSettings } from '../../modules/tools/base.js';
import type { ToolDependencies } from '../../modules/tools/types.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  transcriptionCancellationMessage,
  transcriptionExcerpt,
  transcriptionFileExtensions,
} from '@aime/shared/audio';
import {
  defaultTranscriptionsConfig,
  type TranscriptionsConfig,
} from '@aime/shared/tools';
import type { AudioService } from '../../modules/audio/service.js';
import { optimizeTranscriptionSubtitles } from '../../modules/audio/subtitles.js';
import { normalizeTranscriptionAudio } from '../../modules/audio/convert.js';
import { ThreadError } from '../../modules/threads/errors.js';
import { validatePath } from '../../modules/files/paths.js';
import { assertWorkspacePath } from '../../modules/files/workspace-access.js';
import { readAudioReference } from './audio/context.js';
import {
  transcriptionResponseFormatSchema,
  transcriptionResponseSchema,
} from '../providers/transcription-response.js';

class TranscriptionSaveError extends Error {}

export function createTranscriptionsTool(
  config: TranscriptionsConfig = defaultTranscriptionsConfig,
  audio?: AudioService,
) {
  return createTool({
    id: 'transcriptions',
    description:
      'Transcribe an audio or video file (including MP4, MOV, WebM, MKV and AVI). Accepts a conversation workspace path, a voice audioPath from list_voices, or a public HTTP(S) media URL. Videos are converted to WAV using their complete first audio track; temporary files are deleted after conversion, including on failure or cancellation. Supports long audio/video without a tool-level file-size cap; provider limits and the configured timeout still apply. Returns the OpenAI transcription response structure: an object for json/verbose_json or a string for text/srt/vtt. Only SRT/VTT subtitles are optimized: merge short continuations, split long cues into single-line entries, and remove trailing commas. Split timings are estimated within original cue boundaries. Model output and message previews exceeding 2000 characters show only the beginning and end, including for serialized JSON. Set save_path to save the complete response in the conversation workspace without overwriting existing files. A truncated excerpt is not a complete JSON or subtitle file. The configured ASR model must support the requested response_format.',
    inputSchema: z.strictObject({
      file: z.string().describe('Audio or video file path or public media URL'),
      language: z
        .string()
        .optional()
        .describe('Optional language hint, e.g. zh or en'),
      response_format: transcriptionResponseFormatSchema
        .default('json')
        .describe(
          'Output format, defaults to json. Support depends on the configured ASR model.',
        ),
      save_path: z
        .string()
        .trim()
        .optional()
        .describe(
          'Optional new workspace-relative file path. Extension must match response_format: json/verbose_json → .json, text → .txt, srt → .srt, vtt → .vtt. Creates parent directories; never overwrites existing files. Omit to return the response without saving.',
        ),
    }),
    outputSchema: transcriptionResponseSchema,
    execute: async (input, context) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(config.timeoutMs),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      try {
        signal.throwIfAborted();
        const filesystem = context?.workspace?.filesystem;
        const savePath = input.save_path;
        if (savePath !== undefined) {
          if (!filesystem)
            throw new TranscriptionSaveError(
              'save_path requires a conversation workspace.',
            );
          const extension = transcriptionFileExtensions[input.response_format];
          try {
            validatePath(savePath);
            if (!savePath.toLowerCase().endsWith(`.${extension}`))
              throw new Error('Invalid extension');
            await assertWorkspacePath(filesystem, savePath);
          } catch {
            throw new TranscriptionSaveError(
              `save_path must be a workspace-relative .${extension} file path without parent-directory segments.`,
            );
          }
          if (await filesystem.exists(savePath))
            throw new TranscriptionSaveError(
              'The output file already exists. Choose a new save_path.',
            );
        }
        if (!audio) throw new Error('Audio service unavailable');
        const reference = await readAudioReference(input.file, context, {
          voices: audio.voices,
          signal,
          maxBytes: Infinity,
        });
        const bytes = await normalizeTranscriptionAudio(
          reference.audio,
          signal,
        );
        const response = await audio.transcriptions(bytes, {
          language: input.language,
          response_format: input.response_format,
          model: config.model ?? undefined,
          signal,
        });
        signal.throwIfAborted();
        const result =
          typeof response === 'string' &&
          (input.response_format === 'srt' || input.response_format === 'vtt')
            ? optimizeTranscriptionSubtitles(
                response,
                input.response_format,
                input.language,
              )
            : response;
        if (savePath !== undefined && filesystem) {
          try {
            await assertWorkspacePath(filesystem, savePath);
            signal.throwIfAborted();
            await filesystem.writeFile(
              savePath,
              typeof result === 'string'
                ? result
                : `${JSON.stringify(result, null, 2)}\n`,
              { recursive: true, overwrite: false },
            );
          } catch {
            throw new TranscriptionSaveError(
              'Could not save the transcription. Check workspace write access and choose a new save_path if the file already exists.',
            );
          }
        }
        return result;
      } catch (error) {
        if (context?.abortSignal?.aborted)
          return transcriptionCancellationMessage;
        if (signal.aborted) throw new Error('Speech recognition timed out.');
        if (error instanceof TranscriptionSaveError) throw error;
        if (error instanceof ThreadError) {
          if (error.code === 'AUDIO_CONVERTER_UNAVAILABLE')
            throw new Error(
              'Audio/video conversion requires the ffmpeg-static binary. Reinstall server dependencies with install scripts enabled.',
            );
          if (error.code === 'AUDIO_TRACK_MISSING')
            throw new Error('The media file has no audio track to transcribe.');
        }
        if (error instanceof ThreadError && error.code === 'AUDIO_TOO_LARGE')
          throw new Error(
            'The media source exceeds its size limit. For long media, use a workspace file path or a public media URL instead of a voice-library sample.',
          );
        throw new Error(
          'Speech recognition failed. Check the audio/video file and that the configured ASR model supports the requested response_format.',
        );
      }
    },
    toModelOutput: (output) => ({
      type: 'text',
      value: transcriptionExcerpt(output).text,
    }),
  });
}
export const transcriptions = createTranscriptionsTool();

export class TranscriptionsTool extends BuiltinTool<'transcriptions'> {
  constructor() {
    super(transcriptions, 'transcriptions');
  }

  protected override create(
    config: ToolSettings<'transcriptions'>,
    dependencies: ToolDependencies,
  ) {
    return createTranscriptionsTool(config, dependencies.audio);
  }
}
