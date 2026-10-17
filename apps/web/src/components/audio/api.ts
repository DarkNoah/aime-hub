import type {
  GenerateVoiceInput,
  UpdateVoiceInput,
  Voice,
} from '@aime/shared/audio';
import type { TranslationKey } from '@/i18n/config';

export class AudioApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/audio${path}`, {
    credentials: 'same-origin',
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new AudioApiError(body.code ?? 'INTERNAL_ERROR');
  }
  return response.json();
}
const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
export const audioApi = {
  list: (signal?: AbortSignal) =>
    request<{ voices: Voice[] }>('/voices', { signal }),
  raw: (path: string) =>
    `/api/audio/voices/raw?${new URLSearchParams({ path })}`,
  upload: (
    file: File,
    input: { name: string; description: string; text: string; shared: boolean },
    signal?: AbortSignal,
  ) => {
    const body = new FormData();
    body.set('audio', file);
    body.set('name', input.name);
    body.set('description', input.description);
    body.set('text', input.text);
    body.set('shared', String(input.shared));
    return request<Voice>('/voices', { method: 'POST', body, signal });
  },
  generate: (input: GenerateVoiceInput, signal?: AbortSignal) =>
    request<Voice>('/voices/generate', {
      method: 'POST',
      ...json(input),
      signal,
    }),
  update: (input: UpdateVoiceInput, signal?: AbortSignal) =>
    request<Voice>('/voices', { method: 'PATCH', ...json(input), signal }),
  remove: (path: string) =>
    request<{ ok: true }>(`/voices?${new URLSearchParams({ path })}`, {
      method: 'DELETE',
    }),
  transcribe: (file: File, signal?: AbortSignal) => {
    const body = new FormData();
    body.set('audio', file);
    return request<{ text: string }>('/transcribe', {
      method: 'POST',
      body,
      signal,
    });
  },
};

export function audioErrorKey(error: unknown): TranslationKey {
  if (error instanceof TypeError) return 'errors.network';
  const code = error instanceof AudioApiError ? error.code : '';
  switch (code) {
    case 'UNAUTHORIZED':
      return 'errors.sessionExpired';
    case 'FORBIDDEN':
      return 'errors.forbidden';
    case 'AUDIO_TOO_LARGE':
      return 'voices.tooLarge';
    case 'AUDIO_INVALID':
      return 'voices.invalidAudio';
    case 'AUDIO_CONVERTER_UNAVAILABLE':
      return 'voices.converterUnavailable';
    case 'AUDIO_ASR_UNAVAILABLE':
    case 'AUDIO_TRANSCRIPTION_DISABLED':
      return 'voices.asrUnavailable';
    case 'AUDIO_SPEECH_UNAVAILABLE':
      return 'voices.speechUnavailable';
    case 'AUDIO_TRANSCRIPT_EMPTY':
      return 'voices.emptyTranscript';
    case 'AUDIO_SHARING_PERMANENT':
      return 'voices.sharedLocked';
    default:
      return 'errors.generic';
  }
}
