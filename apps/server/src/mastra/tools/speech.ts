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
import { validatePath } from '../../modules/files/paths.js';
import {
  audioMimeType,
  maxReferenceAudioBytes,
  wavMetadata,
} from '../providers/audio-data.js';
import { requestWebResource } from '../web/request.js';

export class SpeechGenerationError extends Error {}
export type ResolvedSpeechModel = { reference: string; model: SpeechModel };

export function createSpeechTool(
  config: SpeechConfig = defaultSpeechConfig,
  dependencies: {
    resolveModel?: (reference: string | null) => Promise<ResolvedSpeechModel>;
    generate?: typeof generateSpeech;
    request?: typeof requestWebResource;
    recordAsset?: (asset: GeneratedAssetInput) => Promise<void>;
  } = {},
) {
  return createTool({
    id: 'speech',
    description:
      'Convert text to a WAV audio file using the configured speech model. Supports voice names and delivery instructions when the model supports them. For voice cloning, provide ref_audio (workspace path or public HTTP(S) URL) and its exact transcript ref_text together. Reuse the same reference for consistent voices across calls. Saves audio in the conversation workspace and returns its path and playback link.',
    inputSchema: z.strictObject({
      text: z
        .string()
        .trim()
        .min(1)
        .max(32000)
        .describe('Text to convert to speech'),
      language: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Language, when supported by the model; otherwise inferred from text',
        ),
      voice: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .optional()
        .describe('Voice name or identifier supported by the selected model'),
      instruct: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .optional()
        .describe(
          'Voice design or delivery instruction, when supported (VoxCPM2 supports this)',
        ),
      speed: z
        .number()
        .min(0.25)
        .max(4)
        .optional()
        .describe('Speech rate, default 1. VoxCPM2 ignores this parameter.'),
      ref_audio: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Reference WAV, MP3, FLAC or OGG: workspace-relative path or public URL; requires ref_text',
        ),
      ref_text: z
        .string()
        .trim()
        .min(1)
        .max(16000)
        .optional()
        .describe('Exact transcript of ref_audio; requires ref_audio'),
      save_path: z
        .string()
        .trim()
        .min(1)
        .max(2048)
        .optional()
        .describe(
          'New workspace-relative .wav path. Existing files are never overwritten. Defaults to outputs/audio/<random>.wav',
        ),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      isError: z.boolean().optional(),
      model: z.string().optional(),
      file_path: z.string().optional(),
      duration: z.number().positive().optional(),
      sampleRate: z.number().int().positive().optional(),
      asset: z
        .object({
          threadId: z.string(),
          resourceId: z.string(),
          createdBy: z.string().nullable(),
          mimeType: z.string(),
          size: z.number().int().positive(),
        })
        .optional(),
      content: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string() }),
          z.object({
            type: z.literal('file'),
            url: z.string(),
            mimeType: z.literal('audio/wav'),
            filename: z.string(),
          }),
        ]),
      ),
    }),
    execute: async (
      {
        text,
        language,
        voice,
        instruct,
        speed,
        ref_audio,
        ref_text,
        save_path,
      },
      context,
    ) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(config.timeoutMs),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      try {
        signal.throwIfAborted();
        if (!!ref_audio !== !!ref_text)
          throw new SpeechGenerationError(
            'Provide ref_audio and its exact transcript ref_text together for voice cloning.',
          );
        if (!dependencies.resolveModel)
          throw new SpeechGenerationError(
            'Speech model is not configured. Select a model in speech tool settings or set the default speech model.',
          );
        const resolved = await dependencies.resolveModel(config.model);
        const filesystem = context?.workspace?.filesystem;
        if (!filesystem)
          throw new SpeechGenerationError(
            'Speech generation requires a conversation workspace to save the audio.',
          );
        const file_path = save_path ?? `outputs/audio/${randomUUID()}.wav`;
        try {
          validatePath(file_path);
          if (!file_path.toLowerCase().endsWith('.wav'))
            throw new Error('Invalid extension');
        } catch {
          throw new SpeechGenerationError(
            'save_path must be a workspace-relative .wav path without parent-directory segments.',
          );
        }
        if (await filesystem.exists(file_path))
          throw new SpeechGenerationError(
            'The output file already exists. Choose a new save_path.',
          );
        let referenceAudio:
          | {
              promptSpeech: string;
              promptSpeechMediaType: ReturnType<typeof audioMimeType>;
            }
          | undefined;
        if (ref_audio) {
          if (
            typeof resolved.model === 'string' ||
            resolved.model.provider !== 'xinference'
          )
            throw new SpeechGenerationError(
              'Reference audio is currently supported by Xinference speech models. Select a compatible model for voice cloning.',
            );
          try {
            signal.throwIfAborted();
            let data: Buffer;
            if (/^https?:\/\//i.test(ref_audio)) {
              const response = await (
                dependencies.request ?? requestWebResource
              )(ref_audio, { signal, maxBytes: maxReferenceAudioBytes });
              if (response.status !== 200)
                throw new Error('Reference download failed');
              data = response.body;
            } else {
              validatePath(ref_audio);
              const stat = await filesystem.stat(ref_audio);
              if (stat.type !== 'file' || stat.size > maxReferenceAudioBytes)
                throw new Error('Invalid reference size');
              data = Buffer.from(await filesystem.readFile(ref_audio));
            }
            const mimeType = audioMimeType(data);
            if (mimeType === 'audio/wav') wavMetadata(data);
            referenceAudio = {
              promptSpeech: data.toString('base64'),
              promptSpeechMediaType: mimeType,
            };
          } catch {
            throw new SpeechGenerationError(
              'Could not read reference audio. Use an accessible WAV, MP3, FLAC or OGG file in the workspace or a public URL, up to 20 MB.',
            );
          }
        }
        signal.throwIfAborted();
        const result = await (dependencies.generate ?? generateSpeech)({
          model: resolved.model,
          text,
          language,
          voice,
          instructions: instruct,
          speed,
          outputFormat: 'wav',
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: {
            xinference: {
              timeoutMs: config.timeoutMs,
              ...(referenceAudio
                ? { ...referenceAudio, kwargs: { prompt_text: ref_text! } }
                : {}),
            },
          },
        });
        signal.throwIfAborted();
        const data = Buffer.from(result.audio.uint8Array);
        const metadata = wavMetadata(data);
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
        const warnings = result.warnings.map((warning) =>
          warning.type === 'unsupported'
            ? `Unsupported speech option: ${warning.feature}.`
            : 'The speech provider returned a generation warning.',
        );
        return {
          ok: true,
          model: resolved.reference,
          file_path,
          ...metadata,
          ...(threadId && resourceId
            ? {
                asset: {
                  threadId,
                  resourceId,
                  createdBy,
                  mimeType: 'audio/wav',
                  size: data.length,
                },
              }
            : {}),
          content: [
            {
              type: 'text' as const,
              text: [
                `Speech saved to "${file_path}" (${metadata.duration.toFixed(2)} s, ${metadata.sampleRate} Hz, WAV).`,
                ...warnings,
              ].join('\n'),
            },
            ...(threadId
              ? [
                  {
                    type: 'file' as const,
                    url: `/api/threads/${encodeURIComponent(threadId)}/files/raw?${new URLSearchParams({ path: file_path })}`,
                    mimeType: 'audio/wav' as const,
                    filename: file_path,
                  },
                ]
              : []),
          ],
        };
      } catch (error) {
        const message = signal.aborted
          ? context?.abortSignal?.aborted
            ? 'Speech generation was cancelled.'
            : 'Speech generation timed out. Try again or increase the tool timeout.'
          : error instanceof SpeechGenerationError
            ? error.message
            : 'Speech generation failed. Check the selected speech model, its supported options and workspace write access.';
        return {
          ok: false,
          isError: true,
          content: [{ type: 'text' as const, text: message }],
        };
      }
    },
    onOutput: async ({ output, toolCallId }) => {
      if (!output.ok || output.isError || !output.file_path || !output.asset)
        return;
      await dependencies.recordAsset?.({
        ...output.asset,
        path: output.file_path,
        toolName: 'speech',
        toolCallId,
        model: output.model,
        metadata: {
          ...(output.duration ? { duration: output.duration } : {}),
          ...(output.sampleRate ? { sampleRate: output.sampleRate } : {}),
        },
      });
    },
    // Audio stays in the workspace; model history contains only the compact result.
    toModelOutput: (output) => ({
      type: 'text',
      value: output.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    }),
  });
}

export const speech = createSpeechTool();
