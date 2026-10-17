import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { createTool } from '@mastra/core/tools';
import {
  experimental_generateSpeech as generateSpeech,
  type SpeechModel,
} from 'ai';
import { z } from 'zod';
import type { GeneratedAssetInput } from '@aime/shared/assets';
import { defaultSpeechConfig, type SpeechConfig } from '@aime/shared/tools';
import { speechFormats, speechMediaTypes } from '@aime/shared/audio';
import { speechMetadata } from '../../modules/audio/speech-metadata.js';
import { validatePath } from '../../modules/files/paths.js';
import { ThreadError } from '../../modules/threads/errors.js';
import type { AudioService } from '../../modules/audio/service.js';
import { audioUser } from './audio/context.js';
import { SpeechPlayback } from '../../modules/audio/playback.js';
import { supportsSpeechStreaming } from '../providers/speech-model.js';

export class SpeechGenerationError extends Error {}
export type ResolvedSpeechModel = { reference: string; model: SpeechModel };

export function createSpeechTool(
  config: SpeechConfig = defaultSpeechConfig,
  dependencies: {
    resolveModel?: (reference: string | null) => Promise<ResolvedSpeechModel>;
    generate?: typeof generateSpeech;
    recordAsset?: (asset: GeneratedAssetInput) => Promise<void>;
    audio?: AudioService;
  } = {},
) {
  return createTool({
    id: 'speech',
    description:
      'Generate an audio file in the conversation workspace using OpenAI-style speech fields. The model is selected in tool settings. voice first matches a saved personal or shared voice from list_voices; otherwise it is passed as the provider voice ID. To clone a voice, first save its audio and accurate transcript in the voice library, then pass its ID as voice. Saved-voice cloning requires a compatible Xinference model. With play_immediately=true, enqueue playback and return immediately; audio is sent to the frontend without saving a file. Streaming-capable models emit audio chunks; other models emit completed audio. Otherwise returns duration in seconds, file_path and sample_rate in Hz.',
    inputSchema: z.strictObject({
      input: z.string().trim().min(1).describe('Text to convert to speech'),
      voice: z
        .string()
        .trim()
        .optional()
        .describe(
          'Saved voice ID from list_voices, or the selected provider’s voice ID. Saved voices take precedence. Omit for the model default.',
        ),
      instructions: z
        .string()
        .trim()
        .optional()
        .describe(
          'Voice design or delivery instructions, when supported by the model',
        ),
      response_format: z
        .enum(speechFormats)
        .optional()
        .describe(
          'Audio file format, when supported by the model. Defaults to wav. PCM is raw 24 kHz, 16-bit little-endian mono audio.',
        ),
      speed: z
        .number()
        .min(0.25)
        .max(4)
        .optional()
        .describe('Speech rate, default 1. Some models ignore this parameter.'),
      play_immediately: z
        .boolean()
        .optional()
        .describe(
          'Start playback in the current chat and return immediately. Uses streaming when supported; otherwise plays the completed audio. No file is saved; save_path and response_format are ignored. Defaults to false.',
        ),
      save_path: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'New workspace-relative path ending in the response_format extension. Existing files are never overwritten. Defaults to outputs/audio/<random>.<response_format>.',
        ),
    }),
    outputSchema: z.union([
      z.object({
        duration: z.number(),
        file_path: z.string(),
        sample_rate: z.number(),
      }),
      z.object({
        status: z.literal('queued'),
        playback_id: z.string(),
        text: z.string(),
      }),
    ]),
    execute: async (
      {
        input,
        voice,
        instructions,
        response_format = 'wav',
        speed,
        save_path,
        play_immediately = false,
      },
      context,
    ) => {
      const voiceId = voice?.trim() || undefined;
      const voiceUser =
        voiceId && dependencies.audio ? audioUser(context) : undefined;
      const prepare = async (signal: AbortSignal) => {
        if (!dependencies.resolveModel)
          throw new SpeechGenerationError(
            'Speech model is not configured. Select a model in speech tool settings or set the default speech model.',
          );
        const resolved = await dependencies.resolveModel(config.model);
        let savedReference: { audio: Buffer; text: string } | undefined;
        if (voiceId && dependencies.audio) {
          try {
            savedReference = await dependencies.audio.voices.readAudioById(
              voiceUser!,
              voiceId,
            );
          } catch (error) {
            if (!(
              error instanceof ThreadError && error.code === 'FILE_NOT_FOUND'
            ))
              throw new SpeechGenerationError(
                'Could not read the saved voice. Check its audio, transcript and access permissions.',
              );
          }
        }
        if (
          savedReference &&
          (typeof resolved.model === 'string' ||
            resolved.model.provider !== 'xinference')
        )
          throw new SpeechGenerationError(
            'Saved-voice cloning is currently supported by Xinference speech models. Select a compatible model or use a provider voice ID.',
          );
        signal.throwIfAborted();
        return {
          model: resolved.model,
          reference: resolved.reference,
          options: {
            text: input,
            voice: savedReference ? undefined : voiceId,
            instructions,
            speed,
            providerOptions: {
              xinference: {
                timeoutMs: config.timeoutMs,
                ...(savedReference
                  ? {
                      promptSpeech: savedReference.audio.toString('base64'),
                      promptSpeechMediaType: 'audio/wav',
                      kwargs: { prompt_text: savedReference.text },
                    }
                  : {}),
              },
            },
          },
        };
      };
      if (play_immediately) {
        context?.abortSignal?.throwIfAborted();
        const playback = context?.requestContext?.get('speechPlayback');
        if (!(playback instanceof SpeechPlayback))
          throw new SpeechGenerationError(
            'Immediate playback requires an active chat session. Disable play_immediately to save an audio file.',
          );
        const playback_id = playback.start({
          text: input,
          toolCallId: context?.agent?.toolCallId,
          timeoutMs: config.timeoutMs,
          generate: async (signal, emit) => {
            const resolved = await prepare(signal);
            if (supportsSpeechStreaming(resolved.model)) {
              await resolved.model.streamSpeech(
                { ...resolved.options, abortSignal: signal },
                emit,
              );
            } else {
              const result = await (dependencies.generate ?? generateSpeech)({
                model: resolved.model,
                ...resolved.options,
                outputFormat: 'wav',
                maxRetries: 0,
                abortSignal: signal,
              });
              signal.throwIfAborted();
              await emit({
                data: result.audio.uint8Array,
                encoding: 'file',
                mimeType: result.audio.mediaType,
              });
            }
          },
        });
        return { status: 'queued' as const, playback_id, text: input };
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(config.timeoutMs),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      try {
        signal.throwIfAborted();
        const filesystem = context?.workspace?.filesystem;
        if (!filesystem)
          throw new SpeechGenerationError(
            'Speech generation requires a conversation workspace to save the audio.',
          );
        const file_path =
          save_path ?? `outputs/audio/${randomUUID()}.${response_format}`;
        try {
          validatePath(file_path);
          if (!file_path.toLowerCase().endsWith(`.${response_format}`))
            throw new Error('Invalid extension');
        } catch {
          throw new SpeechGenerationError(
            `save_path must be a workspace-relative .${response_format} path without parent-directory segments.`,
          );
        }
        if (await filesystem.exists(file_path))
          throw new SpeechGenerationError(
            'The output file already exists. Choose a new save_path.',
          );
        signal.throwIfAborted();
        const resolved = await prepare(signal);
        const result = await (dependencies.generate ?? generateSpeech)({
          model: resolved.model,
          ...resolved.options,
          outputFormat: response_format,
          maxRetries: 0,
          abortSignal: signal,
        });
        signal.throwIfAborted();
        const data = Buffer.from(result.audio.uint8Array);
        const metadata = await speechMetadata(data, response_format, signal);
        signal.throwIfAborted();
        const directory = posix.dirname(file_path);
        if (directory !== '.')
          await filesystem.mkdir(directory, { recursive: true });
        await filesystem.writeFile(file_path, data, { overwrite: false });
        const actor = context?.requestContext?.get('userId');
        const createdBy =
          typeof actor === 'string' && actor.trim()
            ? actor
            : context?.agent?.resourceId?.startsWith('user:')
              ? context.agent.resourceId.slice(5) || null
              : null;
        const threadId = context?.agent?.threadId;
        const resourceId = context?.agent?.resourceId;
        if (threadId && resourceId)
          await dependencies.recordAsset?.({
            threadId,
            resourceId,
            createdBy,
            mimeType: speechMediaTypes[response_format],
            size: data.length,
            path: file_path,
            toolName: 'speech',
            toolCallId: context?.agent?.toolCallId,
            model: resolved.reference,
            metadata,
          });
        return {
          duration: metadata.duration,
          file_path,
          sample_rate: metadata.sampleRate,
        };
      } catch (error) {
        const message = signal.aborted
          ? context?.abortSignal?.aborted
            ? 'Speech generation was cancelled.'
            : 'Speech generation timed out. Try again or increase the tool timeout.'
          : error instanceof SpeechGenerationError
            ? error.message
            : 'Speech generation failed. Check the selected speech model, its supported options and workspace write access.';
        throw new SpeechGenerationError(message);
      }
    },
    // Audio stays in the workspace; model history contains only the compact result.
    toModelOutput: (output) => ({
      type: 'text',
      value: JSON.stringify(output),
    }),
  });
}

export const speech = createSpeechTool();
