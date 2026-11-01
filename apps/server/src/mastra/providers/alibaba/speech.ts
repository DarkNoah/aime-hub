import type { SpeechModel } from 'ai';
import { z } from 'zod';
import { requestWebResource } from '../../web/request.js';
import { ALIBABA_SPEECH_MODELS } from './catalog.js';
import { AlibabaClient } from './client.js';
type SpeechModelV3 = Extract<SpeechModel, { specificationVersion: 'v3' }>;
type SpeechOptions = Parameters<SpeechModelV3['doGenerate']>[0];

const languageNames: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  es: 'Spanish',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  ru: 'Russian',
  th: 'Thai',
  id: 'Indonesian',
  vi: 'Vietnamese',
  ms: 'Malay',
  fil: 'Filipino',
  ar: 'Arabic',
};
const qwenLanguages = new Set([
  'zh',
  'en',
  'de',
  'it',
  'pt',
  'es',
  'ja',
  'ko',
  'fr',
  'ru',
]);

// Read RIFF chunks rather than estimating duration from the entire file size.
function wavMetadata(audio: Buffer): {
  sampleRate?: number;
  duration?: number;
} {
  if (
    audio.length < 12 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE'
  )
    return {};
  let sampleRate = 0;
  let byteRate = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > audio.length) break;
    const id = audio.toString('ascii', offset, offset + 4);
    if (id === 'fmt ' && size >= 16) {
      sampleRate = audio.readUInt32LE(start + 4);
      byteRate = audio.readUInt32LE(start + 8);
    } else if (id === 'data') dataSize += size;
    offset = start + size + (size % 2);
  }
  return {
    ...(sampleRate > 0 ? { sampleRate } : {}),
    ...(byteRate > 0 && dataSize > 0 ? { duration: dataSize / byteRate } : {}),
  };
}

export class AlibabaSpeechModel implements SpeechModelV3 {
  readonly specificationVersion = 'v3';

  readonly provider = 'alibaba';

  readonly modelId: string;

  private readonly model: (typeof ALIBABA_SPEECH_MODELS)[number];

  private readonly endpoint: string;

  private readonly client: AlibabaClient;

  constructor(options: {
    modelId: string;
    apiKey: string;
    apiBase: string;
    region: string;
    request?: typeof requestWebResource;
    defaultVoice?: string;
  }) {
    const model = ALIBABA_SPEECH_MODELS.find(
      (item) => item.id === options.modelId,
    );
    if (!model || !model.regions.includes(options.region))
      throw new Error(
        `Alibaba speech model ${options.modelId} is not supported in ${options.region}`,
      );
    this.model = {
      ...model,
      defaultVoice: options.defaultVoice || model.defaultVoice,
    };
    this.client = new AlibabaClient(options.apiKey, options.request);
    this.modelId = model.id;
    const base =
      model.family === 'qwen'
        ? `https://${options.region === 'ap-southeast-1' ? 'dashscope-intl' : 'dashscope'}.aliyuncs.com/api/v1`
        : options.apiBase.replace(/\/+$/, '');
    this.endpoint = `${base}/services/${
      model.family === 'audio' || model.family === 'cosy'
        ? 'audio/tts/SpeechSynthesizer'
        : 'aigc/multimodal-generation/generation'
    }`;
  }

  private buildInput(options: SpeechOptions) {
    const { text, instructions, speed = 1 } = options;
    const { family } = this.model;
    if (!text.trim()) throw new Error('Speech text must not be empty');
    if (
      Object.values(options.providerOptions ?? {}).some(
        (value) =>
          value.ref_audio ||
          value.ref_text ||
          value.reference_audio ||
          value.reference_text,
      )
    )
      throw new Error(
        'Alibaba TTS requires an existing voice ID for cloned/designed voices. Create the voice in Alibaba first, then pass voice; ref_audio/ref_text are not supported here.',
      );
    const voice = options.voice?.trim() || this.model.defaultVoice;
    if (!voice)
      throw new Error(
        `${this.modelId} requires an existing custom voice ID in voice`,
      );
    const format = options.outputFormat || 'wav';
    const formats = {
      qwen: ['wav'],
      minimax: ['mp3', 'pcm', 'flac', 'wav'],
      audio: ['mp3', 'pcm', 'wav', 'opus'],
      cosy: ['mp3', 'pcm', 'wav', 'opus'],
    }[family];
    if (!formats.includes(format))
      throw new Error(
        `${this.modelId} does not support output format ${format}`,
      );
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
      throw new Error('Alibaba speech speed must be between 0.5 and 2');
    if (family === 'qwen' && speed !== 1)
      throw new Error('Qwen TTS does not support the speed parameter');
    if (family === 'qwen' && Array.from(text).length > 600)
      throw new Error('Qwen3 TTS text must not exceed 600 characters');
    if (family === 'minimax' && Array.from(text).length >= 10000)
      throw new Error(
        'MiniMax speech text must be shorter than 10000 characters',
      );
    if (
      instructions &&
      (family === 'minimax' ||
        this.modelId === 'cosyvoice-v2' ||
        (family === 'qwen' && this.modelId !== 'qwen3-tts-instruct-flash'))
    )
      throw new Error(`${this.modelId} does not support speech instructions`);
    if (
      instructions &&
      family === 'cosy' &&
      Array.from(instructions).reduce(
        (length, char) => length + (/\p{Script=Han}/u.test(char) ? 2 : 1),
        0,
      ) > 100
    )
      throw new Error(
        'CosyVoice instructions must not exceed 100 characters (Chinese characters count as two)',
      );

    const language = options.language?.trim();
    const code =
      !language || language.toLowerCase() === 'auto'
        ? undefined
        : Object.keys(languageNames).find(
            (key) =>
              key === language.toLowerCase() ||
              languageNames[key].toLowerCase() === language.toLowerCase(),
          );
    if (language && language.toLowerCase() !== 'auto' && !code)
      throw new Error(`Unsupported Alibaba speech language: ${language}`);

    if (family === 'qwen') {
      if (code && !qwenLanguages.has(code))
        throw new Error(`Qwen TTS does not support ${language}`);
      return {
        text,
        voice,
        language_type: code ? languageNames[code] : 'Auto',
        ...(instructions ? { instructions } : {}),
      };
    }
    if (family === 'minimax')
      return {
        text,
        voice_setting: { voice_id: voice, speed },
        audio_setting: { sample_rate: 24000, format, channel: 1 },
        output_format: 'hex',
        language_boost: code ? languageNames[code] : 'auto',
      };
    return {
      text,
      voice,
      format,
      sample_rate: 24000,
      rate: speed,
      ...(code ? { language_hints: [code] } : {}),
      ...(instructions ? { instruction: instructions } : {}),
    };
  }

  async doGenerate(
    options: SpeechOptions,
  ): Promise<Awaited<ReturnType<SpeechModelV3['doGenerate']>>> {
    const signal = options.abortSignal ?? new AbortController().signal;
    signal.throwIfAborted();
    const data = z
      .object({
        output: z.object({
          audio: z.object({ url: z.string() }).nullish(),
          data: z.object({ audio: z.string() }).nullish(),
          base_resp: z
            .object({
              status_code: z.number(),
              status_msg: z.string().optional(),
            })
            .optional(),
          extra_info: z
            .object({
              audio_length: z.number().optional(),
              audio_sample_rate: z.number().optional(),
            })
            .optional(),
        }),
      })
      .parse(
        await this.client.json(this.endpoint, {
          body: { model: this.modelId, input: this.buildInput(options) },
          signal,
          timeoutMs: 0,
          // MiniMax encodes its binary audio as hex inside JSON.
          maxBytes: 100_100_000,
        }),
      );
    if (data.output.base_resp?.status_code)
      throw new Error('Alibaba MiniMax speech generation failed');
    let audio: Buffer;
    if (this.model.family === 'minimax') {
      const hex = data.output.data?.audio;
      if (!hex || !/^(?:[\da-f]{2})+$/i.test(hex))
        throw new Error('Alibaba MiniMax returned invalid hex audio');
      audio = Buffer.from(hex, 'hex');
    } else {
      const url = data.output.audio?.url;
      if (!url) throw new Error('Alibaba speech returned no audio URL');
      audio = await this.client.download(url, signal, 50_000_000, 0);
    }
    signal.throwIfAborted();
    if (!audio.length) throw new Error('Alibaba speech returned empty audio');
    if (audio.length > 50_000_000)
      throw new Error('Alibaba speech audio exceeds the size limit');
    const extra = data.output.extra_info;
    return {
      audio,
      warnings: [],
      response: { timestamp: new Date(), modelId: this.modelId },
      providerMetadata: {
        alibaba: {
          ...wavMetadata(audio),
          ...(extra?.audio_length && extra.audio_length > 0
            ? { duration: extra.audio_length / 1000 }
            : {}),
          ...(extra?.audio_sample_rate && extra.audio_sample_rate > 0
            ? { sampleRate: extra.audio_sample_rate }
            : {}),
        },
      },
    };
  }
}
