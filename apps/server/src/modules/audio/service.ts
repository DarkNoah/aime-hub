import {
  experimental_generateSpeech as generateSpeech,
  experimental_transcribe as transcribe,
} from 'ai';
import {
  generateVoiceSchema,
  type GenerateVoiceInput,
} from '@aime/shared/audio';
import type { TranscribeConfig } from '@aime/shared/tools';
import { defaultTranscribeConfig } from '@aime/shared/tools';
import type { ProviderService } from '../providers/service.js';
import { ThreadError } from '../threads/errors.js';
import { normalizeVoiceAudio } from './convert.js';
import { VoiceStore } from './voices.js';

export class AudioService {
  readonly voices: VoiceStore;
  constructor(
    root: string,
    private readonly providers: Pick<
      ProviderService,
      'getTranscriptionModel' | 'getSpeechModel'
    >,
    private readonly config: () => Promise<TranscribeConfig> = async () =>
      defaultTranscribeConfig,
  ) {
    this.voices = new VoiceStore(root);
  }

  async transcribe(
    audio: Buffer,
    options: {
      model?: string;
      signal?: AbortSignal;
      language?: string;
      prompt?: string;
    } = {},
  ) {
    const config = await this.config();
    if (!config.enabled)
      throw new ThreadError('AUDIO_TRANSCRIPTION_DISABLED', 403);
    const signal = AbortSignal.any([
      AbortSignal.timeout(config.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const model = await this.providers
      .getTranscriptionModel(options.model ?? config.model ?? undefined)
      .catch(() => {
        throw new ThreadError('AUDIO_ASR_UNAVAILABLE');
      });
    const provider =
      typeof model === 'string'
        ? model.split('/')[0]
        : model.provider.split('.')[0];
    const result = await transcribe({
      model,
      audio,
      abortSignal: signal,
      maxRetries: 0,
      providerOptions: {
        [provider]: {
          ...(options.language ? { language: options.language } : {}),
          ...(options.prompt ? { prompt: options.prompt } : {}),
        },
      },
    });
    signal.throwIfAborted();
    if (!result.text.trim()) throw new ThreadError('AUDIO_TRANSCRIPT_EMPTY');
    return {
      text: result.text,
      language: result.language,
      duration: result.durationInSeconds,
      segments: result.segments,
    };
  }

  async generateVoice(
    userId: string,
    input: GenerateVoiceInput,
    abortSignal?: AbortSignal,
  ) {
    const data = generateVoiceSchema.parse(input);
    const signal = AbortSignal.any([
      AbortSignal.timeout(300000),
      ...(abortSignal ? [abortSignal] : []),
    ]);
    const model = await this.providers.getSpeechModel(data.model).catch(() => {
      throw new ThreadError('AUDIO_SPEECH_UNAVAILABLE');
    });
    const result = await generateSpeech({
      model,
      text: data.text,
      voice: data.voice,
      instructions: data.instructions,
      language: data.language,
      outputFormat: 'wav',
      maxRetries: 0,
      abortSignal: signal,
    });
    const audio = await normalizeVoiceAudio(
      Buffer.from(result.audio.uint8Array),
      signal,
    );
    signal.throwIfAborted();
    return this.voices.create(userId, data, audio);
  }
}
