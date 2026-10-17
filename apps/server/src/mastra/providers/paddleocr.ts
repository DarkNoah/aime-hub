import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { allowAllNetworks } from '../../modules/network/policy.js';
import { requestWebResource, webUrl } from '../web/request.js';
import {
  BaseProvider,
  type ProviderConfig,
  type ProviderModelInfo,
} from './base-provider.js';
import type { OcrModel, OcrOptions, OcrResult } from './ocr-model.js';

// Hosted jobs API; a full /layout-parsing URL selects the synchronous service API.
// https://www.paddleocr.ai/latest/version3.x/inference_deployment/serving/paddleocr_official_api/typescript.html
const modelIds = [
  'PP-OCRv5',
  'PP-OCRv5-latin',
  'PP-OCRv6',
  'PP-StructureV3',
  'PaddleOCR-VL',
  'PaddleOCR-VL-1.5',
  'PaddleOCR-VL-1.6',
] as const;
const jobsPath = '/api/v2/ocr/jobs';
const maxFileBytes = 200 * 1024 * 1024;
const maxResultBytes = 20 * 1024 * 1024;
const jobSchema = z.object({
  state: z.enum(['pending', 'running', 'done', 'failed']),
  resultUrl: z.object({ jsonUrl: z.string().optional() }).nullish(),
  errorMsg: z.string().nullish(),
});
const optionsSchema = z.object({
  language: z.string().optional(),
  forceOcr: z.boolean().optional(),
  enableFormula: z.boolean().optional(),
  enableTable: z.boolean().optional(),
  pageRanges: z.string().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});
const ocrResultSchema = z.object({
  result: z.object({
    ocrResults: z.array(
      z.object({ prunedResult: z.object({ rec_texts: z.array(z.string()) }) }),
    ),
  }),
});
const documentResultSchema = z.object({
  result: z.object({
    layoutParsingResults: z.array(
      z.object({
        markdown: z.object({
          text: z.string(),
          images: z.record(z.string(), z.string()).nullish(),
        }),
      }),
    ),
  }),
});

export class PaddleOCRProvider extends BaseProvider {
  readonly name = 'paddleocr';
  readonly type = 'paddleocr';
  private readonly jobsUrl: string;
  private readonly layoutUrl?: string;
  private readonly token: string;

  constructor(
    provider: ProviderConfig,
    private readonly request = requestWebResource,
  ) {
    super({ provider });
    const url = webUrl(provider.baseUrl);
    const token = provider.apiKey?.trim() ?? '';
    const base = url.href.replace(/\/+$/, '');
    if (url.pathname.replace(/\/+$/, '').endsWith('/layout-parsing'))
      this.layoutUrl = base;
    if (
      (!allowAllNetworks() && url.protocol !== 'https:') ||
      url.search ||
      url.hash ||
      (!this.layoutUrl && !token) ||
      /[\r\n]/.test(token)
    )
      throw new Error('Invalid PaddleOCR provider configuration');
    this.token = token;
    this.jobsUrl = base.endsWith(jobsPath) ? base : `${base}${jobsPath}`;
  }

  async getOcrModelList(): Promise<ProviderModelInfo[]> {
    return (this.layoutUrl ? ['PaddleOCR-VL'] : modelIds).map((id) => ({
      id,
      name: id,
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
    const model = z.enum(modelIds).parse(modelId);
    if (this.layoutUrl && model !== 'PaddleOCR-VL')
      throw new Error(
        'The layout-parsing endpoint uses its deployed PaddleOCR-VL model',
      );
    return {
      provider: this.name,
      modelId: model,
      supportsPageRanges: !this.layoutUrl,
      doOCR: (options) => this.parse(model, options),
    };
  }

  private async parse(model: string, options: OcrOptions): Promise<OcrResult> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.provider.timeoutMs ?? 600_000),
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    signal.throwIfAborted();
    const parsed = optionsSchema.parse(options);
    if (this.layoutUrl) return this.parseLayout(options, signal);
    if (parsed.language !== undefined || parsed.forceOcr === false)
      throw new Error(
        'PaddleOCR does not support language or disabling OCR; select an appropriate OCR model instead',
      );
    const optionalPayload = { ...parsed.providerOptions };
    if (
      parsed.enableFormula !== undefined ||
      parsed.enableTable !== undefined
    ) {
      if (model !== 'PP-StructureV3')
        throw new Error(
          'PaddleOCR enableFormula and enableTable require PP-StructureV3',
        );
      if (parsed.enableFormula !== undefined)
        optionalPayload.useFormulaRecognition = parsed.enableFormula;
      if (parsed.enableTable !== undefined)
        optionalPayload.useTableRecognition = parsed.enableTable;
    }
    let body: string | Buffer;
    let contentType: string;
    if (options.input.url !== undefined) {
      body = JSON.stringify({
        model,
        fileUrl: webUrl(options.input.url).href,
        optionalPayload,
        pageRanges: parsed.pageRanges,
      });
      contentType = 'application/json';
    } else {
      const { data, fileName } = options.input;
      if (
        !(data instanceof Uint8Array) ||
        !data.byteLength ||
        data.byteLength > maxFileBytes
      )
        throw new Error(
          'PaddleOCR requires a non-empty file of at most 200 MB',
        );
      if (
        !fileName ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        [...fileName].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) ||
        !/\.(pdf|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(fileName)
      )
        throw new Error('Unsupported PaddleOCR file name');
      const form = new FormData();
      form.append('model', model);
      form.append('optionalPayload', JSON.stringify(optionalPayload));
      if (parsed.pageRanges !== undefined)
        form.append('pageRanges', parsed.pageRanges);
      form.append('file', new Blob([new Uint8Array(data)]), fileName);
      // Encode multipart with the runtime while retaining the shared DNS/network policy.
      const encoded = new Request(this.jobsUrl, { method: 'POST', body: form });
      contentType = encoded.headers.get('content-type')!;
      body = Buffer.from(await encoded.arrayBuffer());
    }
    const { jobId } = await this.requestJson(
      '',
      z.object({ jobId: z.string().min(1) }),
      signal,
      { body, contentType },
    );
    let interval = 3000;
    while (true) {
      const job = await this.requestJson(
        `/${encodeURIComponent(jobId)}`,
        jobSchema,
        signal,
      );
      if (job.state === 'failed')
        throw new Error(
          `PaddleOCR parsing failed: ${this.safeMessage(job.errorMsg ?? 'Unknown error')}`,
        );
      if (job.state === 'done') {
        if (!job.resultUrl?.jsonUrl)
          throw new Error('PaddleOCR result URL is missing');
        const resultUrl = this.resourceUrl(job.resultUrl.jsonUrl);
        const markdown = await this.readMarkdown(resultUrl, model, signal);
        return { markdown, resultUrl, taskId: jobId };
      }
      try {
        await delay(interval, undefined, { signal });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
      interval = Math.min(interval * 1.5, 15_000);
    }
  }

  private safeMessage(message: string) {
    return (
      this.token ? message.replaceAll(this.token, '[redacted]') : message
    ).slice(0, 500);
  }

  private async parseLayout(
    options: OcrOptions,
    signal: AbortSignal,
  ): Promise<OcrResult> {
    if (
      options.pageRanges !== undefined ||
      options.language !== undefined ||
      options.forceOcr === false ||
      options.enableFormula !== undefined ||
      options.enableTable !== undefined
    )
      throw new Error(
        'The layout-parsing endpoint does not support page ranges, language, forceOcr, enableFormula or enableTable options',
      );
    const providerOptions = z
      .object({ useChartRecognition: z.boolean().optional() })
      .strict()
      .parse(options.providerOptions ?? {});
    let file: string;
    let fileType: 0 | 1 | undefined;
    if (options.input.url !== undefined) {
      file = webUrl(options.input.url).href;
    } else {
      const { data, fileName } = options.input;
      if (
        !(data instanceof Uint8Array) ||
        !data.byteLength ||
        data.byteLength > maxFileBytes
      )
        throw new Error(
          'PaddleOCR requires a non-empty file of at most 200 MB',
        );
      if (
        !fileName ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        [...fileName].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) ||
        !/\.(pdf|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(fileName)
      )
        throw new Error('Unsupported PaddleOCR file name');
      file = Buffer.from(data).toString('base64');
      fileType = /\.pdf$/i.test(fileName) ? 0 : 1;
    }
    const response = await this.request(this.layoutUrl!, {
      method: 'POST',
      signal,
      maxBytes: maxResultBytes,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        file,
        fileType,
        ...providerOptions,
        returnMarkdownImages: false,
        visualize: false,
      }),
    });
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300)
      throw new Error(`PaddleOCR request failed (${response.status})`);
    const raw = this.parseJson(response.body.toString('utf8'));
    const envelope = z
      .object({
        logId: z.string(),
        errorCode: z.number(),
        errorMsg: z.string().optional(),
      })
      .safeParse(raw);
    if (!envelope.success) throw new Error('Invalid PaddleOCR layout response');
    if (envelope.data.errorCode !== 0)
      throw new Error(
        `PaddleOCR API error (${envelope.data.errorCode}): ${this.safeMessage(envelope.data.errorMsg ?? 'Unknown error')}`,
      );
    const result = documentResultSchema.safeParse(raw);
    if (!result.success || !result.data.result.layoutParsingResults.length)
      throw new Error('Invalid PaddleOCR document result');
    return {
      markdown: result.data.result.layoutParsingResults
        .map(({ markdown }) => markdown.text)
        .join('\n\n'),
      taskId: envelope.data.logId,
    };
  }

  private resourceUrl(value: string) {
    const url = webUrl(value);
    if (!allowAllNetworks() && url.protocol !== 'https:')
      throw new Error('PaddleOCR resource URL must use HTTPS');
    return url.href;
  }

  private async readMarkdown(
    resultUrl: string,
    model: string,
    signal: AbortSignal,
  ) {
    let url = resultUrl;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      // Result storage and redirects must never receive the AI Studio token.
      const response = await this.request(url, {
        signal,
        maxBytes: maxResultBytes,
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
        throw new Error(
          `PaddleOCR result download failed (${response.status})`,
        );
      const pages: string[] = [];
      for (const line of response.body.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const raw = this.parseJson(line);
        if (model.startsWith('PP-OCR')) {
          const parsed = ocrResultSchema.safeParse(raw);
          if (!parsed.success) throw new Error('Invalid PaddleOCR OCR result');
          pages.push(
            ...parsed.data.result.ocrResults.map(({ prunedResult }) =>
              prunedResult.rec_texts.join('\n'),
            ),
          );
        } else {
          const parsed = documentResultSchema.safeParse(raw);
          if (!parsed.success)
            throw new Error('Invalid PaddleOCR document result');
          for (const { markdown } of parsed.data.result.layoutParsingResults) {
            let text = markdown.text;
            for (const [path, imageUrl] of Object.entries(
              markdown.images ?? {},
            )) {
              // Resolve per page so repeated image paths on later pages remain distinct.
              const target = this.resourceUrl(imageUrl);
              text = text.replaceAll(`](${path})`, `](<${target}>)`);
            }
            pages.push(text);
          }
        }
      }
      if (!pages.length) throw new Error('PaddleOCR result contains no pages');
      return pages.join('\n\n');
    }
    throw new Error('Too many PaddleOCR result redirects');
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Invalid PaddleOCR JSON response');
    }
  }

  private async requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    payload?: { body: string | Buffer; contentType: string },
  ): Promise<T> {
    signal.throwIfAborted();
    const response = await this.request(`${this.jobsUrl}${path}`, {
      method: payload ? 'POST' : 'GET',
      signal,
      maxBytes: 2_000_000,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(payload ? { 'content-type': payload.contentType } : {}),
      },
      body: payload?.body,
    });
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300)
      throw new Error(`PaddleOCR request failed (${response.status})`);
    const envelope = z
      .object({
        code: z.number().optional(),
        msg: z.string().optional(),
        data: z.unknown().optional(),
      })
      .safeParse(this.parseJson(response.body.toString('utf8')));
    if (!envelope.success) throw new Error('Invalid PaddleOCR response');
    if (envelope.data.code !== undefined && envelope.data.code !== 0)
      throw new Error(
        `PaddleOCR API error (${envelope.data.code}): ${this.safeMessage(envelope.data.msg ?? 'Unknown error')}`,
      );
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) throw new Error('Invalid PaddleOCR response data');
    return parsed.data;
  }
}
