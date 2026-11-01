import { setTimeout as delay } from 'node:timers/promises';
import type { TranscriptionModel } from 'ai';
import { z } from 'zod';
import { requestWebResource, webUrl } from '../../web/request.js';
import {
  transcriptionResponseFormatSchema,
  type TranscriptionResponseFormat,
} from '../transcription-response.js';
import { ALIBABA_TRANSCRIPTION_MODELS } from './catalog.js';
import { AlibabaClient } from './client.js';
import { uploadToAlibabaOss } from './upload.js';

type TranscriptionModelV3 = Extract<
  TranscriptionModel,
  { specificationVersion: 'v3' }
>;
type Options = Parameters<TranscriptionModelV3['doGenerate']>[0];
type Result = Awaited<ReturnType<TranscriptionModelV3['doGenerate']>>;
const formats: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/x-ms-wma': 'wma',
};
const wordSchema = z.object({
  text: z.string(),
  begin_time: z.number().nonnegative(),
  end_time: z.number().nonnegative(),
  punctuation: z.string().optional(),
});
const sentenceSchema = wordSchema.extend({
  language: z.string().optional(),
  words: z.array(wordSchema).optional(),
});
const outputSchema = z.object({
  sentence: sentenceSchema.optional(),
  output: z.object({ sentence: sentenceSchema.optional() }).optional(),
  text: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.union([
            z.string(),
            z.array(z.object({ text: z.string() })),
          ]),
          annotations: z
            .array(
              z.object({ type: z.string(), language: z.string().optional() }),
            )
            .optional(),
        }),
      }),
    )
    .optional(),
});
const fileSchema = z.object({
  transcription_url: z.string().optional(),
  subtask_status: z.string().optional(),
});
const taskSchema = z.object({
  output: z.object({
    task_id: z.string().min(1),
    task_status: z.string(),
    result: fileSchema.optional(),
    results: z.array(fileSchema).optional(),
  }),
  usage: z
    .object({ seconds: z.number().optional(), duration: z.number().optional() })
    .optional(),
});
const transcriptSchema = z.object({
  transcripts: z.array(
    z.object({ text: z.string(), sentences: z.array(sentenceSchema) }),
  ),
  properties: z
    .object({
      original_duration_in_milliseconds: z.number().nonnegative().optional(),
    })
    .optional(),
});

function segments(
  sentences: z.infer<typeof sentenceSchema>[],
): Result['segments'] {
  return sentences
    .flatMap((sentence) =>
      (sentence.words?.length ? sentence.words : [sentence]).map((item) => {
        if (item.end_time < item.begin_time)
          throw new Error('Alibaba returned invalid timestamps');
        return {
          text: item.text + (item.punctuation ?? ''),
          startSecond: item.begin_time / 1000,
          endSecond: item.end_time / 1000,
        };
      }),
    )
    .sort((a, b) => a.startSecond - b.startSecond);
}
function timestamp(seconds: number, format: 'srt' | 'vtt') {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`;
}

/** Native ASR with an OpenAI-compatible response body for AudioService/tools. */
export class AlibabaTranscriptionModel implements TranscriptionModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'alibaba';
  readonly modelId: string;
  private readonly mode: (typeof ALIBABA_TRANSCRIPTION_MODELS)[number]['mode'];
  private readonly apiBase: string;
  private readonly client: AlibabaClient;

  constructor(options: {
    modelId: string;
    apiBase: string;
    apiKey: string;
    region: string;
    request?: typeof requestWebResource;
  }) {
    const model = ALIBABA_TRANSCRIPTION_MODELS.find(
      (item) =>
        item.id === options.modelId && item.regions.includes(options.region),
    );
    if (!model)
      throw new Error(
        `Alibaba transcription model ${options.modelId} is not supported in ${options.region}`,
      );
    this.modelId = model.id;
    this.mode = model.mode;
    this.apiBase = options.apiBase.replace(/\/+$/, '');
    this.client = new AlibabaClient(options.apiKey, options.request);
  }

  private checkFormat(format: TranscriptionResponseFormat) {
    if (this.mode === 'qwen-flash' && (format === 'srt' || format === 'vtt'))
      throw new Error(
        'Qwen3 ASR Flash does not return subtitle timestamps; select a Filetrans model',
      );
  }

  async doGenerate(options: Options): Promise<Result> {
    const signal = options.abortSignal ?? AbortSignal.timeout(300_000);
    signal.throwIfAborted();
    const responseFormat = transcriptionResponseFormatSchema.parse(
      options.providerOptions?.alibaba?.response_format ?? 'json',
    );
    this.checkFormat(responseFormat);
    const mediaType = options.mediaType.split(';')[0].trim().toLowerCase();
    const format = formats[mediaType];
    if (!format)
      throw new Error(`Unsupported Alibaba audio format: ${mediaType}`);
    const audio =
      typeof options.audio === 'string'
        ? Buffer.from(options.audio, 'base64')
        : options.audio;
    const maxBytes =
      this.mode === 'qwen-flash' ? 10 * 1024 * 1024 : 1024 * 1024 * 1024;
    if (!audio.byteLength || audio.byteLength > maxBytes)
      throw new Error('Alibaba audio is empty or exceeds the model size limit');
    const prefix = `data:${mediaType};base64,`;
    let source: string;
    if (
      this.mode !== 'async' &&
      prefix.length + 4 * Math.ceil(audio.byteLength / 3) <= 10 * 1024 * 1024
    ) {
      source = prefix + Buffer.from(audio).toString('base64');
    } else {
      const policy = z
        .object({ data: z.unknown() })
        .parse(
          await this.client.json(
            `${this.apiBase}/uploads?action=getPolicy&model=${encodeURIComponent(this.modelId)}`,
            { signal },
          ),
        );
      source = await uploadToAlibabaOss(
        policy.data,
        {
          data: audio,
          fileName: `audio.${format}`,
          mimeType: mediaType,
          abortSignal: signal,
        },
        this.client.request,
      );
    }
    return this.transcribe(source, format, signal, responseFormat);
  }

  canGenerateFromUrl(url: string) {
    const parsed = webUrl(url);
    return (
      this.mode !== 'flash' ||
      Object.values(formats).includes(
        parsed.pathname.split('.').at(-1)?.toLowerCase() ?? '',
      )
    );
  }

  async doGenerateFromUrl(options: {
    url: string;
    abortSignal?: AbortSignal;
    responseFormat?: TranscriptionResponseFormat;
  }): Promise<Result> {
    const parsed = webUrl(options.url);
    const responseFormat = options.responseFormat ?? 'json';
    this.checkFormat(responseFormat);
    const extension = parsed.pathname.split('.').at(-1)?.toLowerCase();
    const format =
      extension && Object.values(formats).includes(extension)
        ? extension
        : undefined;
    return this.transcribe(
      options.url,
      format,
      options.abortSignal ?? AbortSignal.timeout(300_000),
      responseFormat,
    );
  }

  private async transcribe(
    source: string,
    format: string | undefined,
    signal: AbortSignal,
    responseFormat: TranscriptionResponseFormat,
  ): Promise<Result> {
    const resolveHeaders: Record<string, string> = source.startsWith('oss://')
      ? { 'X-DashScope-OssResourceResolve': 'enable' }
      : {};
    if (this.mode !== 'async') {
      if (this.mode === 'flash' && !format)
        throw new Error('Alibaba Flash requires a known audio format');
      const qwen = this.mode === 'qwen-flash';
      const raw = await this.client.json(
        `${this.apiBase}/services/aigc/multimodal-generation/generation`,
        {
          signal,
          headers: { ...resolveHeaders, 'X-DashScope-SSE': 'disable' },
          body: {
            model: this.modelId,
            input: {
              messages: [
                {
                  role: 'user',
                  content: [
                    qwen
                      ? { audio: source }
                      : { type: 'input_audio', input_audio: { data: source } },
                  ],
                },
              ],
            },
            parameters: qwen
              ? { asr_options: { enable_itn: false }, result_format: 'message' }
              : { format },
          },
        },
      );
      const data = z
        .object({
          output: outputSchema,
          usage: z
            .object({
              seconds: z.number().optional(),
              duration: z.number().optional(),
            })
            .optional(),
        })
        .parse(raw);
      if (qwen) {
        const message = data.output.choices?.[0]?.message;
        if (!message)
          throw new Error('Alibaba Qwen ASR returned no transcript');
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content.map((item) => item.text).join('');
        return this.result(
          text,
          [],
          responseFormat,
          data.usage?.seconds,
          message.annotations?.find((item) => item.type === 'audio_info')
            ?.language,
        );
      }
      const sentence = data.output.sentence ?? data.output.output?.sentence;
      const text = data.output.text ?? sentence?.text;
      if (text === undefined)
        throw new Error('Alibaba Flash ASR returned no transcript');
      return this.result(
        text,
        sentence ? segments([sentence]) : [],
        responseFormat,
        data.usage?.duration,
        sentence?.language,
      );
    }
    const qwenFile = this.modelId.startsWith('qwen3-asr-flash-filetrans');
    let data = taskSchema.parse(
      await this.client.json(
        `${this.apiBase}/services/audio/asr/transcription`,
        {
          signal,
          headers: { ...resolveHeaders, 'X-DashScope-Async': 'enable' },
          body: {
            model: this.modelId,
            input: qwenFile ? { file_url: source } : { file_urls: [source] },
            parameters: {
              channel_id: [0],
              ...(qwenFile ? { enable_itn: false, enable_words: true } : {}),
            },
          },
        },
      ),
    );
    const taskId = data.output.task_id;
    while (['PENDING', 'RUNNING'].includes(data.output.task_status)) {
      await delay(3000, undefined, { signal });
      data = taskSchema.parse(
        await this.client.json(
          `${this.apiBase}/tasks/${encodeURIComponent(taskId)}`,
          { signal },
        ),
      );
      if (data.output.task_id !== taskId)
        throw new Error('Alibaba transcription task ID does not match');
    }
    if (data.output.task_status !== 'SUCCEEDED')
      throw new Error('Alibaba transcription task failed or expired');
    const entries = qwenFile ? [data.output.result] : data.output.results;
    if (!entries || entries.length !== 1)
      throw new Error('Alibaba returned no file result');
    const entry = entries[0];
    if (
      !entry?.transcription_url ||
      (!qwenFile && entry.subtask_status !== 'SUCCEEDED')
    )
      throw new Error('Alibaba transcription file failed');
    const transcript = transcriptSchema.parse(
      await this.client.json(entry.transcription_url, {
        signal,
        authenticated: false,
      }),
    );
    const sentences = transcript.transcripts.flatMap(
      (channel) => channel.sentences,
    );
    const languages = [
      ...new Set(
        sentences.map((sentence) => sentence.language).filter(Boolean),
      ),
    ];
    const duration = transcript.properties?.original_duration_in_milliseconds;
    return this.result(
      transcript.transcripts.map((channel) => channel.text).join('\n'),
      segments(sentences),
      responseFormat,
      duration === undefined ? undefined : duration / 1000,
      languages.length === 1 ? languages[0] : undefined,
    );
  }

  private result(
    text: string,
    segments: Result['segments'],
    format: TranscriptionResponseFormat,
    duration?: number,
    language?: string,
  ): Result {
    let body: unknown = {
      text,
      ...(language ? { language } : {}),
      ...(duration === undefined ? {} : { duration }),
      segments: segments.map(({ text, startSecond, endSecond }) => ({
        text,
        start: startSecond,
        end: endSecond,
      })),
    };
    if (format === 'text') body = text;
    if (format === 'srt' || format === 'vtt') {
      if (text.trim() && !segments.length)
        throw new Error('This Alibaba model returned no subtitle timestamps');
      body =
        (format === 'vtt' ? 'WEBVTT\n\n' : '') +
        segments
          .map(
            (segment, index) =>
              `${index + 1}\n${timestamp(segment.startSecond, format)} --> ${timestamp(segment.endSecond, format)}\n${segment.text}`,
          )
          .join('\n\n');
    }
    return {
      text,
      segments,
      language,
      durationInSeconds: duration,
      warnings: [],
      response: { timestamp: new Date(), modelId: this.modelId, body },
    };
  }
}
