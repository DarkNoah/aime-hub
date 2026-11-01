import { z } from 'zod';
import { uploadToAlibabaOss } from './upload.js';
import { AlibabaClient } from './client.js';
import { requestWebResource } from '../../web/request.js';
import { ALIBABA_3D_MODELS } from './catalog.js';
import type {
  Model3D,
  Model3DGenerationOptions,
  Model3DTask,
} from '../model3d.js';

const views = ['front', 'left', 'back', 'right'] as const;

function publicUrl(value: unknown, allowOss = false): string {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (
        (allowOss ? ['http:', 'https:', 'oss:'] : ['http:', 'https:']).includes(
          url.protocol,
        ) &&
        !url.username &&
        !url.password
      )
        return value;
    } catch {
      /* A local path is not a URL. */
    }
  }
  throw new Error(
    'Tripo requires a public HTTP(S) URL or an uploaded oss:// reference',
  );
}

function imageFormat(image: string, explicit?: 'jpeg' | 'png') {
  publicUrl(image, true);
  const extension = /\.([^./]+)$/
    .exec(new URL(image).pathname)?.[1]
    ?.toLowerCase();
  const inferred = (
    { jpg: 'jpeg', jpeg: 'jpeg', png: 'png' } as Record<string, 'jpeg' | 'png'>
  )[extension ?? ''];
  if (explicit && !['jpeg', 'png'].includes(explicit))
    throw new Error('Tripo supports JPEG and PNG images only');
  if (explicit && inferred && explicit !== inferred)
    throw new Error('Image format does not match the URL extension');
  if (!explicit && !inferred)
    throw new Error(
      'Specify image format (jpeg or png) for a multi-view URL without a JPEG/PNG extension',
    );
  return explicit || inferred;
}

export class Alibaba3DModel implements Model3D {
  readonly provider = 'alibaba';

  readonly modelId: string;

  readonly pollingIntervalMs = 15000;

  private readonly apiBase: string;

  private readonly client: AlibabaClient;

  constructor(options: {
    modelId: string;
    region: string;
    apiBase: string;
    apiKey: string;
    request?: typeof requestWebResource;
  }) {
    if (
      options.region !== 'cn-beijing' ||
      !ALIBABA_3D_MODELS.some(({ id }) => id === options.modelId)
    )
      throw new Error(
        `Alibaba 3D model ${options.modelId} is not supported in ${options.region}`,
      );
    this.modelId = options.modelId;
    this.apiBase = options.apiBase.replace(/\/+$/, '');
    this.client = new AlibabaClient(options.apiKey, options.request);
  }

  private async request(
    endpoint: string,
    abortSignal?: AbortSignal,
    body?: object,
    resolveOss = false,
  ) {
    const signal = abortSignal ?? AbortSignal.timeout(120_000);
    return this.client.json(`${this.apiBase}${endpoint}`, {
      signal,
      body,
      timeoutMs: 120_000,
      headers: {
        ...(resolveOss ? { 'X-DashScope-OssResourceResolve': 'enable' } : {}),
        ...(body ? { 'X-DashScope-Async': 'enable' } : {}),
      },
    });
  }

  async uploadImage(options: {
    data: Uint8Array;
    fileName: string;
    mimeType: string;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    if (
      !['image/jpeg', 'image/png'].includes(options.mimeType) ||
      !options.data.byteLength ||
      options.data.byteLength > 20 * 1024 * 1024
    )
      throw new Error('Tripo upload requires a JPEG/PNG image up to 20 MB');
    const response = await this.request(
      `/uploads?action=getPolicy&model=${encodeURIComponent(this.modelId)}`,
      options.abortSignal,
    );
    return uploadToAlibabaOss(
      z.object({ data: z.unknown() }).parse(response).data,
      options,
      this.client.request,
    );
  }

  private static parseTask(data: unknown): Model3DTask {
    const { output } = z
      .object({
        output: z.object({
          task_id: z.string().min(1),
          task_status: z.enum([
            'PENDING',
            'RUNNING',
            'SUCCEEDED',
            'FAILED',
            'CANCELED',
          ]),
          message: z.string().optional(),
          code: z.string().optional(),
          results: z
            .array(
              z.object({
                pbr_model_url: z.string().optional(),
                base_model_url: z.string().optional(),
                rendered_image_url: z.string().optional(),
              }),
            )
            .optional(),
        }),
      })
      .parse(data);
    if (!output || typeof output.task_id !== 'string' || !output.task_id)
      throw new Error('Alibaba 3D response has no task ID');
    const status = (
      {
        PENDING: 'queued',
        RUNNING: 'running',
        SUCCEEDED: 'succeeded',
        FAILED: 'failed',
        CANCELED: 'cancelled',
      } satisfies Record<string, Model3DTask['status']>
    )[output.task_status];
    if (!status)
      throw new Error(
        `Alibaba 3D task ${output.task_id} has unknown or expired status: ${output.task_status}`,
      );
    const task: Model3DTask = {
      taskId: output.task_id,
      status,
      ...(output.message || output.code
        ? { error: 'Alibaba 3D task failed' }
        : {}),
    };
    if (status === 'succeeded') {
      if (!Array.isArray(output.results) || !output.results.length)
        throw new Error('Alibaba 3D task succeeded without model results');
      task.results = output.results.map((result) => ({
        url: publicUrl(result?.pbr_model_url || result?.base_model_url),
        format: 'glb',
        ...(result?.rendered_image_url
          ? { previewUrl: publicUrl(result.rendered_image_url) }
          : {}),
      }));
    }
    return task;
  }

  async doGenerate(options: Model3DGenerationOptions) {
    options.abortSignal?.throwIfAborted();
    const modes = [
      options.prompt !== undefined,
      options.image !== undefined,
      options.images !== undefined,
    ];
    if (modes.filter(Boolean).length !== 1)
      throw new Error('Specify exactly one of prompt, image or images');
    let input: object;
    if (options.prompt !== undefined) {
      if (!options.prompt.trim() || Array.from(options.prompt).length > 1024)
        throw new Error('Tripo prompt must contain 1–1024 characters');
      input = { prompt: options.prompt };
    } else if (options.image !== undefined) {
      const image = publicUrl(options.image, true);
      if (/\.(webp|gif|bmp|svg|heic)$/i.test(new URL(image).pathname))
        throw new Error('Tripo supports JPEG and PNG images only');
      input = { image };
    } else {
      const images = options.images ?? [];
      if (
        images.length < 2 ||
        images.length > 4 ||
        new Set(images.map(({ view }) => view)).size !== images.length
      )
        throw new Error(
          'Provide 2–4 images with distinct front/left/back/right views',
        );
      if (images.some(({ view }) => !views.includes(view)))
        throw new Error('Invalid 3D image view');
      input = {
        images: views.map((view) => {
          const image = images.find((item) => item.view === view);
          return image
            ? {
                type: imageFormat(image.image, image.format),
                file_token: image.image,
              }
            : {};
        }),
      };
    }
    if (
      options.geometryQuality !== undefined &&
      this.modelId !== 'Tripo/Tripo-H3.1'
    )
      throw new Error('geometry_quality is supported only by Tripo H3.1');
    if (
      options.geometryQuality &&
      !['standard', 'ultra'].includes(options.geometryQuality)
    )
      throw new Error('Invalid geometry quality');
    if (
      options.textureQuality &&
      !['standard', 'detailed'].includes(options.textureQuality)
    )
      throw new Error('Invalid texture quality');
    const data = await this.request(
      '/services/aigc/video-generation/3d-generation',
      options.abortSignal,
      {
        model: this.modelId,
        input,
        parameters: {
          texture: options.textured ?? true,
          pbr: options.textured ?? true,
          ...(options.textureQuality
            ? { texture_quality: options.textureQuality }
            : {}),
          ...(options.geometryQuality
            ? { geometry_quality: options.geometryQuality }
            : {}),
        },
      },
      [options.image, ...(options.images ?? []).map(({ image }) => image)].some(
        (image) => /^oss:\/\//i.test(image ?? ''),
      ),
    );
    return Alibaba3DModel.parseTask(data);
  }

  async getTask(taskId: string, options?: { abortSignal?: AbortSignal }) {
    if (!taskId.trim()) throw new Error('3D task ID is required');
    const data = await this.request(
      `/tasks/${encodeURIComponent(taskId)}`,
      options?.abortSignal,
    );
    const task = Alibaba3DModel.parseTask(data);
    if (task.taskId !== taskId)
      throw new Error('Alibaba 3D returned a different task ID');
    return task;
  }
}
