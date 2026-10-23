import { BuiltinTool, type ToolSettings } from '../../modules/tools/base.js';
import type { ToolDependencies } from '../../modules/tools/types.js';
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
import { normalizeVoiceAudio } from '../../modules/audio/convert.js';
import { validatePath } from '../../modules/files/paths.js';
import { ThreadError } from '../../modules/threads/errors.js';
import type { AudioService } from '../../modules/audio/service.js';
import { audioUser, readAudioReference } from './audio/context.js';
import { SpeechPlayback } from '../../modules/audio/playback.js';
import {
  supportsSpeechReferences,
  supportsSpeechStreaming,
  type SpeechProviderOptions,
} from '../providers/speech-model.js';

export class SpeechGenerationError extends Error {}
export type ResolvedSpeechModel = { reference: string; model: SpeechModel };
const cancellationMessage = 'Speech generation was cancelled.';

function voiceSelectionError(input: {
  voice?: string;
  reference_audio?: string;
  reference_text?: string;
}) {
  const voice = input.voice?.trim();
  const audio = input.reference_audio?.trim();
  const text = input.reference_text?.trim();
  if (voice && (audio || text))
    return 'Choose either voice or reference_audio with reference_text, not both.';
  if (!voice && (!audio || !text))
    return 'Provide voice, or both reference_audio and reference_text.';
}

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
      'Generate speech using either voice or both reference_audio and reference_text; choose exactly one source, never omit both. The model is selected in tool settings. voice first matches a saved personal or shared voice from list_voices; otherwise it is passed as the provider voice ID. To clone a voice directly, pass reference_audio and its accurate transcript as reference_text without saving it to the voice library. Reference-audio cloning requires a compatible Xinference or OpenAI-compatible model supporting reference_audio and reference_text. With play_immediately=true, enqueue playback and return immediately; audio is sent to the frontend without saving a file. Streaming-capable models emit audio chunks; other models emit completed audio. Otherwise save audio in the conversation workspace and return duration in seconds, file_path and sample_rate in Hz.',
    inputSchema: z
      .strictObject({
        input: z.string().trim().min(1).describe('Text to convert to speech'),
        voice: z
          .string()
          .trim()
          .optional()
          .describe(
            'Saved voice ID from list_voices, or the selected provider’s voice ID. Saved voices take precedence. Required unless reference_audio and reference_text are provided; do not combine with them.',
          ),
        reference_audio: z
          .string()
          .trim()
          .optional()
          .describe(
            'Reference audio for voice cloning: conversation workspace path, audioPath from list_voices, or public HTTP(S) audio URL. Provide reference_text with it and omit voice.',
          ),
        reference_text: z
          .string()
          .trim()
          .optional()
          .describe(
            'Accurate transcript of reference_audio, not the new speech input. Required together with reference_audio; omit when using voice.',
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
          .describe(
            'Speech rate, default 1. Some models ignore this parameter.',
          ),
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
      })
      .superRefine((input, context) => {
        const message = voiceSelectionError(input);
        if (message)
          context.addIssue({ code: 'custom', message, path: ['voice'] });
      }),
    outputSchema: z.union([
      z.literal(cancellationMessage),
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
        reference_audio,
        reference_text,
        instructions,
        response_format = 'wav',
        speed,
        save_path,
        play_immediately = false,
      },
      context,
    ) => {
      if (context?.abortSignal?.aborted) return cancellationMessage;
      const selectionError = voiceSelectionError({
        voice,
        reference_audio,
        reference_text,
      });
      if (selectionError) throw new SpeechGenerationError(selectionError);
      const voiceId = voice?.trim() || undefined;
      const referenceAudio = reference_audio?.trim();
      const voiceUser =
        voiceId && dependencies.audio ? audioUser(context) : undefined;
      const prepare = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (!dependencies.resolveModel)
          throw new SpeechGenerationError(
            'Speech model is not configured. Select a model in speech tool settings or set the default speech model.',
          );
        const resolved = await dependencies.resolveModel(config.model);
        signal.throwIfAborted();
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
          (savedReference || referenceAudio) &&
          !supportsSpeechReferences(resolved.model)
        )
          throw new SpeechGenerationError(
            'Reference-audio cloning requires a compatible Xinference or OpenAI-compatible speech model. Select a compatible model or use a provider voice ID.',
          );
        if (referenceAudio) {
          try {
            const reference = await readAudioReference(
              referenceAudio,
              context,
              {
                voices: dependencies.audio?.voices,
                signal,
              },
            );
            savedReference = {
              audio: await normalizeVoiceAudio(reference.audio, signal),
              text: reference_text!.trim(),
            };
          } catch {
            signal.throwIfAborted();
            throw new SpeechGenerationError(
              'Could not read reference_audio. Check the audio format, file path or public URL, and access permissions.',
            );
          }
        }
        signal.throwIfAborted();
        const provider =
          typeof resolved.model === 'string'
            ? undefined
            : resolved.model.provider;
        const providerOptions: SpeechProviderOptions = {};
        if (provider === 'xinference') {
          providerOptions.xinference = {
            timeoutMs: config.timeoutMs,
            ...(savedReference
              ? {
                  promptSpeech: savedReference.audio.toString('base64'),
                  promptSpeechMediaType: 'audio/wav',
                  kwargs: { prompt_text: savedReference.text },
                }
              : {}),
          };
        } else if (savedReference && provider) {
          providerOptions[provider] = {
            reference_audio: savedReference.audio.toString('base64'),
            reference_text: savedReference.text,
          };
        }
        return {
          model: resolved.model,
          reference: resolved.reference,
          options: {
            text: input,
            voice: savedReference ? undefined : voiceId,
            instructions,
            speed,
            providerOptions,
          },
        };
      };
      if (play_immediately) {
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
        if (context?.abortSignal?.aborted) return cancellationMessage;
        const message = signal.aborted
          ? 'Speech generation timed out. Try again or increase the tool timeout.'
          : error instanceof SpeechGenerationError
            ? error.message
            : 'Speech generation failed. Check the selected speech model, its supported options and workspace write access.';
        throw new SpeechGenerationError(message);
      }
    },
    // Audio stays in the workspace; model history contains only the compact result.
    toModelOutput: (output) => ({
      type: 'text',
      value: typeof output === 'string' ? output : JSON.stringify(output),
    }),
  });
}

export const speech = createSpeechTool();

export class SpeechTool extends BuiltinTool<'speech'> {
  constructor() {
    super(speech, 'speech');
  }

  protected override create(
    config: ToolSettings<'speech'>,
    dependencies: ToolDependencies,
  ) {
    return createSpeechTool(config, {
      resolveModel: dependencies.speechModel,
      recordAsset: dependencies.recordAsset,
      audio: dependencies.audio,
    });
  }
}
