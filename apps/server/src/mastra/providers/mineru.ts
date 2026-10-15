import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { allowAllNetworks } from '../../modules/network/policy.js';
import { requestWebResource, webUrl } from '../web/request.js';
import {
  BaseProvider,
  type ProviderConfig,
  type ProviderModelInfo,
} from './base-provider.js';
import type { OcrModel, OcrOptions, OcrResult } from './ocr-model.js';

const modelIds = ['vlm', 'pipeline'] as const;
const maxFileBytes = 200 * 1024 * 1024;
const maxMarkdownBytes = 20 * 1024 * 1024;
const taskSchema = z.object({
  state: z.enum([
    'waiting-file',
    'pending',
    'running',
    'converting',
    'done',
    'failed',
  ]),
  full_zip_url: z.string().optional(),
  err_msg: z.string().optional(),
});
const parseOptionsSchema = z.object({
  language: z.string().trim().min(1).max(64).optional(),
  forceOcr: z.boolean().optional(),
  enableFormula: z.boolean().optional(),
  enableTable: z.boolean().optional(),
  pageRanges: z.string().trim().min(1).max(1000).optional(),
});

export class MinerUProvider extends BaseProvider {
  readonly name = 'mineru';
  readonly type = 'mineru';
  private readonly baseUrl: string;

  constructor(
    provider: ProviderConfig,
    private readonly request = requestWebResource,
  ) {
    super({ provider });
    const url = webUrl(provider.baseUrl);
    if (
      (!allowAllNetworks() && url.protocol !== 'https:') ||
      url.search ||
      url.hash ||
      !provider.apiKey?.trim()
    )
      throw new Error('Invalid MinerU provider configuration');
    const base = url.href.replace(/\/+$/, '');
    this.baseUrl = base.endsWith('/api/v4') ? base : `${base}/api/v4`;
  }

  async getOcrModelList(): Promise<ProviderModelInfo[]> {
    // The precise parsing API exposes fixed model versions, not an OpenAI /models endpoint.
    return modelIds.map((id) => ({
      id,
      name: id === 'vlm' ? 'MinerU VLM' : 'MinerU Pipeline',
      modelType: 'ocr',
      modalitiesInput: ['pdf', 'image'],
      modalitiesOutput: ['text'],
    }));
  }

  getModelList() {
    return this.getOcrModelList();
  }

  languageModel(modelId: string): never {
    throw new Error(`Language model is not supported: ${this.type}/${modelId}`);
  }

  ocrModel(modelId: string): OcrModel {
    const version = z.enum(modelIds).parse(modelId);
    return {
      provider: this.name,
      modelId: version,
      doOCR: (options) => this.parse(version, options),
    };
  }

  private async parse(
    modelId: (typeof modelIds)[number],
    options: OcrOptions,
  ): Promise<OcrResult> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.provider.timeoutMs ?? 600_000),
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    signal.throwIfAborted();
    const parsed = parseOptionsSchema.parse(options);
    const common = {
      model_version: modelId,
      language: parsed.language,
      enable_formula: parsed.enableFormula,
      enable_table: parsed.enableTable,
    };
    const fileOptions = {
      is_ocr: parsed.forceOcr ?? true,
      page_ranges: parsed.pageRanges,
    };
    let taskId: string;
    let resultPath: string;
    let batch = false;
    if (options.input.url !== undefined) {
      const url = webUrl(options.input.url).href;
      const created = await this.requestJson(
        'extract/task',
        z.object({ task_id: z.string().min(1) }),
        signal,
        {
          ...common,
          ...fileOptions,
          url,
        },
      );
      taskId = created.task_id;
      resultPath = `extract/task/${encodeURIComponent(taskId)}`;
    } else {
      const { data, fileName } = options.input;
      if (
        !(data instanceof Uint8Array) ||
        !data.byteLength ||
        data.byteLength > maxFileBytes
      )
        throw new Error('MinerU requires a non-empty file of at most 200 MB');
      if (
        !fileName ||
        fileName.length > 256 ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        [...fileName].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) ||
        !/\.(pdf|docx?|pptx?|xlsx?|png|jpe?g|jp2|webp|gif|bmp)$/i.test(fileName)
      )
        throw new Error('Unsupported MinerU OCR file name');
      const created = await this.requestJson(
        'file-urls/batch',
        z.object({
          batch_id: z.string().min(1),
          file_urls: z.array(z.string().min(1)).length(1),
        }),
        signal,
        { ...common, files: [{ name: fileName, ...fileOptions }] },
      );
      taskId = created.batch_id;
      resultPath = `extract-results/batch/${encodeURIComponent(taskId)}`;
      batch = true;
      // Signed storage URLs must never receive the provider token or a Content-Type header.
      const uploaded = await this.request(
        this.resourceUrl(created.file_urls[0]!),
        {
          method: 'PUT',
          signal,
          body: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
          maxBytes: 1_000_000,
        },
      );
      signal.throwIfAborted();
      if (uploaded.status < 200 || uploaded.status >= 300)
        throw new Error(`MinerU upload failed (${uploaded.status})`);
    }

    while (true) {
      signal.throwIfAborted();
      const task = batch
        ? (
            await this.requestJson(
              resultPath,
              z.object({ extract_result: z.array(taskSchema).length(1) }),
              signal,
            )
          ).extract_result[0]!
        : await this.requestJson(resultPath, taskSchema, signal);
      if (task.state === 'failed')
        throw new Error(
          `MinerU parsing failed: ${this.safeMessage(task.err_msg ?? 'Unknown error')}`,
        );
      if (task.state === 'done') {
        if (!task.full_zip_url)
          throw new Error('MinerU result archive is missing');
        const archiveUrl = this.resourceUrl(task.full_zip_url);
        const markdown = await this.readMarkdown(archiveUrl, signal);
        return { markdown, archiveUrl, taskId };
      }
      try {
        await delay(2000, undefined, { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
  }

  private safeMessage(message: string) {
    return message
      .replaceAll(this.provider.apiKey!, '[redacted]')
      .slice(0, 500);
  }

  private resourceUrl(value: string) {
    const url = webUrl(value);
    if (!allowAllNetworks() && url.protocol !== 'https:')
      throw new Error('MinerU resource URL must use HTTPS');
    return url.href;
  }

  private async readMarkdown(
    archiveUrl: string,
    signal: AbortSignal,
  ): Promise<string> {
    let url = archiveUrl;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await this.request(url, {
        signal,
        maxBytes: 100 * 1024 * 1024,
      });
      signal.throwIfAborted();
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.headers.location
      ) {
        url = this.resourceUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.status !== 200)
        throw new Error(`MinerU result download failed (${response.status})`);
      let markdownFiles = 0;
      const files = unzipSync(response.body, {
        filter: ({ name, originalSize }) => {
          if (name !== 'full.md' && !name.endsWith('/full.md')) return false;
          if (++markdownFiles > 1 || originalSize > maxMarkdownBytes)
            throw new Error('Invalid or oversized MinerU Markdown result');
          return true;
        },
      });
      signal.throwIfAborted();
      const markdown = Object.values(files)[0];
      if (!markdown || !markdown.length || markdown.length > maxMarkdownBytes)
        throw new Error('MinerU Markdown result is missing or oversized');
      // Only read Markdown in memory. Relative image links refer to files in archiveUrl.
      return Buffer.from(markdown).toString('utf8');
    }
    throw new Error('Too many MinerU result redirects');
  }

  private async requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    signal.throwIfAborted();
    const response = await this.request(`${this.baseUrl}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      maxBytes: 2_000_000,
      headers: {
        authorization: `Bearer ${this.provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    signal.throwIfAborted();
    if (response.status !== 200)
      throw new Error(`MinerU request failed (${response.status})`);
    let raw: unknown;
    try {
      raw = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new Error('Invalid MinerU JSON response');
    }
    const envelope = z
      .object({
        code: z.union([z.number(), z.string()]),
        msg: z.string().optional(),
        data: z.unknown().optional(),
      })
      .safeParse(raw);
    if (!envelope.success) throw new Error('Invalid MinerU response');
    if (envelope.data.code !== 0)
      throw new Error(
        `MinerU API error (${this.safeMessage(String(envelope.data.code))}): ${this.safeMessage(envelope.data.msg ?? 'Unknown error')}`,
      );
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) throw new Error('Invalid MinerU response data');
    return parsed.data;
  }
}
