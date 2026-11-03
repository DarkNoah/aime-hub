export type SpeechProgress = { loaded: number; total?: number };
export type SpeechCallbacks = {
  onProgress: (progress: SpeechProgress) => void;
  onLine: (id: string, text: string) => void;
  onError: (error: unknown) => void;
};

export type SenseVoiceRequest =
  | { type: 'load'; runtimeBase: string }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'finish' };

export type SenseVoiceResponse =
  | { type: 'ready' | 'finished' }
  | { type: 'progress'; progress: SpeechProgress }
  | { type: 'line'; id: string; text: string }
  | { type: 'accepted'; samples: number }
  | { type: 'error'; message: string };
