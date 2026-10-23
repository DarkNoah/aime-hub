import { BuiltinTool, type ToolSettings } from '../../modules/tools/base.js';
import type { ToolDependencies } from '../../modules/tools/types.js';
import { randomUUID } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { generateImage, type ImageModel } from 'ai';
import { z } from 'zod';
import { imageSize } from 'image-size';
import type { GeneratedAssetInput } from '@aime/shared/assets';
import { defaultImageGenConfig, type ImageGenConfig } from '@aime/shared/tools';
import {
  imageBase64,
  imageMimeType,
  maxImageBytes,
} from '../providers/image-data.js';
import { requestWebResource } from '../web/request.js';

export class ImageGenerationError extends Error {}
export type ResolvedImageModel = { reference: string; model: ImageModel };

export function createImageGenTool(
  config: ImageGenConfig = defaultImageGenConfig,
  dependencies: {
    resolveModel?: (reference: string | null) => Promise<ResolvedImageModel>;
    generate?: typeof generateImage;
    request?: typeof requestWebResource;
    recordAsset?: (asset: GeneratedAssetInput) => Promise<void>;
  } = {},
) {
  return createTool({
    id: 'image_gen',
    description:
      'Generate an image from a detailed prompt or edit reference images. Reference images can be workspace paths, public HTTP(S) URLs, or base64 data URLs (PNG, JPEG, WebP). Set remove_background for transparent output when the selected model supports it. Returns the generated image and its workspace path when available.',
    inputSchema: z.strictObject({
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(32000)
        .describe(
          'Detailed description of the image to create or the changes to make',
        ),
      ref_images: z
        .array(z.string().min(1).max(28_000_000))
        .max(4)
        .optional()
        .describe(
          'Reference image paths in the conversation workspace, public URLs, or image data URLs',
        ),
      remove_background: z
        .boolean()
        .optional()
        .describe('Request a transparent PNG background'),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      isError: z.boolean().optional(),
      model: z.string().optional(),
      file_path: z.string().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      asset: z
        .object({
          threadId: z.string(),
          resourceId: z.string(),
          createdBy: z.string().nullable(),
          mimeType: z.string(),
          size: z.number().int().nonnegative(),
        })
        .optional(),
      content: z.array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('text'), text: z.string() }),
          z.object({
            type: z.literal('image'),
            data: z.string(),
            mimeType: z.string(),
          }),
        ]),
      ),
    }),
    execute: async ({ prompt, ref_images, remove_background }, context) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(config.timeoutMs),
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      try {
        signal.throwIfAborted();
        if (!dependencies.resolveModel)
          throw new ImageGenerationError(
            'Image generation model is not configured. Select a model in tool settings or set the default image generation model.',
          );
        const resolved = await dependencies.resolveModel(config.model);
        signal.throwIfAborted();
        const images: Uint8Array[] = [];
        try {
          let totalBytes = 0;
          for (const reference of ref_images ?? []) {
            signal.throwIfAborted();
            let data: Buffer;
            if (reference.startsWith('data:')) {
              const match = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/.exec(
                reference,
              );
              if (!match) throw new Error('Invalid data URL');
              data = imageBase64(match[1]);
            } else if (/^https?:\/\//i.test(reference)) {
              const response = await (
                dependencies.request ?? requestWebResource
              )(reference, { signal, maxBytes: maxImageBytes });
              if (response.status !== 200)
                throw new Error('Image download failed');
              data = response.body;
            } else {
              const fs = context?.workspace?.filesystem;
              if (!fs) throw new Error('No workspace');
              const stat = await fs.stat(reference);
              if (stat.type !== 'file' || stat.size > maxImageBytes)
                throw new Error('Invalid image file');
              data = Buffer.from(await fs.readFile(reference));
            }
            imageMimeType(data);
            totalBytes += data.length;
            if (totalBytes > 40_000_000)
              throw new Error('Reference images are too large');
            images.push(data);
          }
        } catch {
          throw new ImageGenerationError(
            'Could not read reference images. Use accessible PNG, JPEG or WebP images, up to 20 MB each and 40 MB total.',
          );
        }
        signal.throwIfAborted();
        const result = await (dependencies.generate ?? generateImage)({
          model: resolved.model,
          prompt: images.length ? { text: prompt, images } : prompt,
          n: 1,
          maxRetries: 0,
          abortSignal: signal,
          ...(remove_background
            ? { providerOptions: { openai: { background: 'transparent' } } }
            : {}),
        });
        signal.throwIfAborted();
        const data = result.image.uint8Array;
        const mimeType = imageMimeType(data);
        const { width, height } = imageSize(data);
        if (!width || !height) throw new Error('Invalid image dimensions');
        const filesystem = context?.workspace?.filesystem;
        const actor = context?.requestContext?.get('userId');
        const createdBy =
          typeof actor === 'string' && actor.trim()
            ? actor
            : context?.agent?.resourceId?.startsWith('user:')
              ? context.agent.resourceId.slice(5) || null
              : null;
        let file_path: string | undefined;
        if (filesystem) {
          const directory = 'outputs/images';
          await filesystem.mkdir(directory, { recursive: true });
          file_path = `${directory}/${randomUUID()}.${mimeType.split('/')[1]}`;
          await filesystem.writeFile(file_path, Buffer.from(data));
        }
        return {
          ok: true,
          model: resolved.reference,
          file_path,
          width,
          height,
          ...(file_path && context?.agent?.threadId && context.agent.resourceId
            ? {
                asset: {
                  threadId: context.agent.threadId,
                  resourceId: context.agent.resourceId,
                  createdBy,
                  mimeType,
                  size: data.length,
                },
              }
            : {}),
          content: [
            {
              type: 'text' as const,
              text: file_path
                ? `Image saved to "${file_path}" (${width} × ${height})`
                : `Image generated successfully (${width} × ${height}).`,
            },
            {
              type: 'image' as const,
              data: Buffer.from(data).toString('base64'),
              mimeType,
            },
          ],
        };
      } catch (error) {
        const text = signal.aborted
          ? context?.abortSignal?.aborted
            ? 'Image generation was cancelled.'
            : 'Image generation timed out. Try again or increase the tool timeout.'
          : error instanceof ImageGenerationError
            ? error.message
            : 'Image generation failed. Check that the selected provider supports image generation and the requested editing or transparency options.';
        return {
          ok: false,
          isError: true,
          content: [{ type: 'text' as const, text }],
        };
      }
    },
    onOutput: async ({ output, toolCallId }) => {
      if (!output.ok || output.isError || !output.file_path || !output.asset)
        return;
      await dependencies.recordAsset?.({
        ...output.asset,
        path: output.file_path,
        metadata: {
          ...(output.width ? { width: output.width } : {}),
          ...(output.height ? { height: output.height } : {}),
        },
        toolName: 'image_gen',
        toolCallId,
        model: output.model,
      });
    },
    toModelOutput: (output) => ({
      type: 'content',
      value: output.content.map((part) =>
        part.type === 'image'
          ? { type: 'image-data', data: part.data, mediaType: part.mimeType }
          : part,
      ),
    }),
  });
}

export const imageGen = createImageGenTool();

export class ImageGenTool extends BuiltinTool<'image_gen'> {
  constructor() {
    super(imageGen, 'image_gen');
  }

  protected override create(
    config: ToolSettings<'image_gen'>,
    dependencies: ToolDependencies,
  ) {
    return createImageGenTool(config, {
      resolveModel: dependencies.imageModel,
      recordAsset: dependencies.recordAsset,
    });
  }
}
