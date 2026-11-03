import captureUrl from './speech-capture.worklet.js?url&no-inline';
import type {
  SenseVoiceRequest,
  SenseVoiceResponse,
  SpeechCallbacks,
} from './speech-input-types';

export class SenseVoiceSession {
  private worker?: Worker;
  private media?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private closed = false;
  private recording = false;
  private queuedSamples = 0;
  private finishCapture?: () => void;
  private pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  constructor(private readonly callbacks: SpeechCallbacks) {}

  private waitFor(type: 'ready' | 'finished') {
    return new Promise<void>((resolve, reject) => {
      this.pending.set(type, { resolve, reject });
    });
  }

  private post(message: SenseVoiceRequest, transfer: Transferable[] = []) {
    this.worker?.postMessage(message, transfer);
  }

  private fail(error: Error) {
    if (this.closed) return;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.callbacks.onError(error);
    this.dispose();
  }

  async load() {
    if (this.closed) return;
    const worker = new Worker(
      new URL('./sensevoice.worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker = worker;
    worker.onerror = (event) =>
      this.fail(new Error(event.message || 'Speech worker failed'));
    worker.onmessageerror = () =>
      this.fail(new Error('Invalid speech worker response'));
    worker.onmessage = (event: MessageEvent<SenseVoiceResponse>) => {
      if (this.closed) return;
      const message = event.data;
      switch (message.type) {
        case 'progress':
          this.callbacks.onProgress(message.progress);
          break;
        case 'line':
          this.callbacks.onLine(message.id, message.text);
          break;
        case 'accepted':
          this.queuedSamples -= message.samples;
          break;
        case 'error':
          this.fail(new Error(message.message));
          break;
        default:
          this.pending.get(message.type)?.resolve();
          this.pending.delete(message.type);
      }
    };
    const ready = this.waitFor('ready');
    this.post({
      type: 'load',
      runtimeBase: new URL(
        `${import.meta.env.BASE_URL}sensevoice/0.3.0/`,
        window.location.href,
      ).href,
    });
    await ready;
  }

  async start() {
    if (this.closed || !this.worker) return;
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    if (this.closed) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
    media.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (!this.closed) this.fail(new Error('Microphone ended'));
      };
    });
    // The Web Audio graph resamples microphone input to the model's 16 kHz.
    const context = new AudioContext({ sampleRate: 16000 });
    this.context = context;
    await context.resume();
    if (this.closed) return;
    if (context.sampleRate !== 16000)
      throw new Error('16 kHz audio is unavailable');
    await context.audioWorklet.addModule(captureUrl);
    if (this.closed) return;
    this.source = context.createMediaStreamSource(media);
    this.capture = new AudioWorkletNode(context, 'speech-capture');
    this.capture.port.onmessage = (
      event: MessageEvent<Float32Array | string>,
    ) => {
      if (this.closed || typeof event.data === 'string') return;
      // Bound work queued behind synchronous WASM decoding on slower devices.
      this.queuedSamples += event.data.length;
      if (this.queuedSamples > 16000 * 30) {
        this.fail(new Error('Speech recognition is too slow'));
        return;
      }
      this.post({ type: 'audio', samples: event.data }, [event.data.buffer]);
    };
    this.source.connect(this.capture);
    this.capture.connect(context.destination);
    this.recording = true;
  }

  async stop() {
    this.source?.disconnect();
    this.media?.getTracks().forEach((track) => track.stop());
    try {
      if (!this.recording || this.closed) return;
      const capture = this.capture!;
      // MessagePort ordering puts the last PCM batch ahead of the finish request.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          capture.port.removeEventListener('message', flushed);
          this.finishCapture = undefined;
          resolve();
        };
        const flushed = (event: MessageEvent) => {
          if (event.data === 'flushed') done();
        };
        const timeout = setTimeout(done, 250);
        this.finishCapture = done;
        capture.port.addEventListener('message', flushed);
        capture.port.postMessage('flush');
      });
      if (this.closed) return;
      const finished = this.waitFor('finished');
      this.post({ type: 'finish' });
      await finished;
    } finally {
      this.dispose();
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.recording = false;
    this.finishCapture?.();
    for (const pending of this.pending.values()) {
      pending.reject(
        new DOMException('Speech recognition cancelled', 'AbortError'),
      );
    }
    this.pending.clear();
    this.source?.disconnect();
    this.capture?.disconnect();
    this.capture?.port.close();
    this.media?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => {});
    this.worker?.terminate();
  }
}
