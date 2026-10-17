import captureUrl from './speech-capture.worklet.js?url&no-inline';
import type { SttWorkerHost } from '@moonshine-ai/moonshine-wasm';

type Moonshine = typeof import('@moonshine-ai/moonshine-wasm');
export type SpeechProgress = { loaded: number; total?: number };
export type SpeechCallbacks = {
  onProgress: (progress: SpeechProgress) => void;
  onLine: (id: string, text: string) => void;
  onError: (error: unknown) => void;
};

export class MoonshineSession {
  private host?: SttWorkerHost;
  private media?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private closed = false;
  private recording = false;

  constructor(private readonly callbacks: SpeechCallbacks) {}

  async load(language: 'zh' | 'en') {
    const url = `${import.meta.env.BASE_URL}moonshine/0.1.5/index.js`;
    const { SttWorkerHost, ModelArch } = (await import(
      /* @vite-ignore */ url
    )) as Moonshine;
    if (this.closed) return;
    const host = new SttWorkerHost();
    this.host = host;
    host.onProgress = (_id, loaded, total) =>
      this.callbacks.onProgress({ loaded, total });
    // 0.1.5's actual WASM catalog only offers Base for Mandarin.
    await host.loadTranscriber({
      transcriberId: 'dictation',
      modelArch: language === 'zh' ? ModelArch.Base : ModelArch.TinyStreaming,
      source: { kind: 'catalog', language },
      options: language === 'zh' ? { max_tokens_per_second: '13' } : undefined,
    });
    if (this.closed) return;
    await host.createStream('dictation', 'microphone', {
      updateInterval: language === 'zh' ? 0.5 : 0.2,
    });
    host.setListener('microphone', {
      onLineTextChanged: ({ line }) =>
        this.callbacks.onLine(line.id, line.text),
      onLineCompleted: ({ line }) => this.callbacks.onLine(line.id, line.text),
      onError: ({ error }) => this.callbacks.onError(error),
    });
  }

  async start() {
    if (this.closed || !this.host) return;
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    // Permission may resolve after cancellation or after changing chats.
    if (this.closed) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
    media.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (!this.closed) this.callbacks.onError(new Error('Microphone ended'));
      };
    });
    const context = new AudioContext();
    this.context = context;
    await context.resume();
    if (this.closed) return;
    await context.audioWorklet.addModule(captureUrl);
    if (this.closed) return;
    await this.host.start('microphone');
    if (this.closed) return;
    this.source = context.createMediaStreamSource(media);
    this.capture = new AudioWorkletNode(context, 'speech-capture');
    this.capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.closed || typeof event.data === 'string') return;
      // Stop rather than accumulating an unbounded backlog on slow devices.
      if (this.host!.queuedSeconds('microphone') > 15) {
        this.callbacks.onError(new Error('Speech recognition is too slow'));
        return;
      }
      this.host!.addAudio('microphone', event.data, context.sampleRate);
    };
    this.source.connect(this.capture);
    this.capture.connect(context.destination);
    this.recording = true;
  }

  async stop() {
    this.source?.disconnect();
    this.media?.getTracks().forEach((track) => track.stop());
    try {
      if (this.recording && !this.closed) {
        const capture = this.capture!;
        // Deliver the final partial audio buffer before flushing the decoder.
        await new Promise<void>((resolve) => {
          const done = (event: MessageEvent) => {
            if (event.data !== 'flushed') return;
            clearTimeout(timeout);
            capture.port.removeEventListener('message', done);
            resolve();
          };
          const timeout = setTimeout(() => {
            capture.port.removeEventListener('message', done);
            resolve();
          }, 250);
          capture.port.addEventListener('message', done);
          capture.port.postMessage('flush');
        });
        await this.host?.stop('microphone');
      }
    } finally {
      this.dispose();
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.recording = false;
    this.source?.disconnect();
    this.capture?.disconnect();
    this.capture?.port.close();
    this.media?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => {});
    this.host?.close();
  }
}
