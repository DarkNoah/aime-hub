import type { SpeechEvent } from '@aime/shared/audio';

type Chunk = Extract<SpeechEvent, { phase: 'chunk' }>;
export type SpeechPlaybackState = {
  text: string;
  status: 'generating' | 'playing' | 'blocked';
  queued: number;
} | null;

type Track = {
  id: string;
  text: string;
  sequence: number;
  chunks: Chunk[];
  format?: Pick<Chunk, 'encoding' | 'mimeType' | 'sampleRate' | 'channels'>;
  parts: Uint8Array[];
  remainder: Uint8Array;
  sources: Set<AudioBufferSourceNode>;
  size: number;
  ended: boolean;
  decoding: boolean;
  decoded: boolean;
  nextTime: number;
};

/** PCM chunks are raw frames, not independently decodable audio files. */
export class SpeechPlayer {
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private frequencies = new Uint8Array(0);
  private tracks: Track[] = [];
  private seen = new Set<string>();
  private disposed = false;
  constructor(
    private readonly changed: (state: SpeechPlaybackState) => void,
    private readonly failed: () => void,
    private readonly createContext = () => new AudioContext(),
  ) {}

  private audioContext() {
    if (!this.context) {
      this.context = this.createContext();
      this.context.onstatechange = () => this.publish();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.65;
      this.analyser.minDecibels = -80;
      this.analyser.maxDecibels = -20;
      this.frequencies = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.connect(this.context.destination);
    }
    return this.context;
  }

  /** Read the sound being played, including silence between scheduled chunks. */
  readSpectrum(levels: Float32Array) {
    levels.fill(0);
    if (
      this.disposed ||
      !this.analyser ||
      this.context?.state !== 'running' ||
      !this.tracks[0]?.sources.size
    )
      return;
    this.analyser.getByteFrequencyData(this.frequencies);
    const binWidth = this.context.sampleRate / this.analyser.fftSize;
    const low = 100;
    const high = Math.min(8000, this.context.sampleRate / 2);
    // Logarithmic bands give the lower speech frequencies room to move.
    for (let band = 0; band < levels.length; band++) {
      const start = Math.floor(
        (low * (high / low) ** (band / levels.length)) / binWidth,
      );
      const end = Math.min(
        this.frequencies.length,
        Math.max(
          start + 1,
          Math.ceil(
            (low * (high / low) ** ((band + 1) / levels.length)) / binWidth,
          ),
        ),
      );
      let energy = 0;
      for (let bin = start; bin < end; bin++)
        energy += (this.frequencies[bin] / 255) ** 2;
      levels[band] = Math.max(
        0,
        (Math.sqrt(energy / (end - start)) - 0.05) / 0.95,
      );
    }
  }

  /** Call from a user gesture; blocked browsers also get an explicit resume button. */
  unlock() {
    if (this.disposed) return;
    try {
      const context = this.audioContext();
      void context.resume().catch(() => this.publish());
    } catch {
      if (this.tracks.length) this.stopWithError();
    }
  }

  receive(event: SpeechEvent) {
    if (this.disposed) return;
    if (event.phase === 'start') {
      if (event.sequence !== 0 || this.seen.has(event.playbackId)) return;
      this.seen.add(event.playbackId);
      if (this.seen.size > 128)
        this.seen.delete(this.seen.values().next().value!);
      if (this.tracks.length >= 16) return this.stopWithError();
      this.tracks.push({
        id: event.playbackId,
        text: event.text,
        sequence: 1,
        chunks: [],
        parts: [],
        remainder: new Uint8Array(),
        sources: new Set(),
        size: 0,
        ended: false,
        decoding: false,
        decoded: false,
        nextTime: 0,
      });
      this.publish();
      return;
    }
    const track = this.tracks.find((item) => item.id === event.playbackId);
    // Never resume a partial utterance after an SSE reconnect or a local stop.
    if (!track) return;
    if (event.sequence !== track.sequence++) return this.remove(track, true);
    if (event.phase === 'cancelled' || event.phase === 'error') {
      this.remove(track, event.phase === 'error');
      return;
    }
    if (event.phase === 'end') track.ended = true;
    else {
      if (track.ended) return this.remove(track, true);
      track.size += event.audio.length * 0.75;
      if (this.tracks.reduce((size, item) => size + item.size, 0) > 50_000_000)
        return this.stopWithError();
      track.chunks.push(event);
    }
    this.drain();
  }

  private publish() {
    if (this.disposed) return;
    const track = this.tracks[0];
    this.changed(
      track
        ? {
            text: track.text,
            status: track.sources.size
              ? this.context?.state === 'running'
                ? 'playing'
                : 'blocked'
              : 'generating',
            queued: this.tracks.length - 1,
          }
        : null,
    );
  }

  private schedule(track: Track, buffer: AudioBuffer) {
    const context = this.audioContext();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    track.sources.add(source);
    source.onended = () => {
      source.disconnect();
      track.sources.delete(source);
      if (this.tracks[0] === track) this.finish(track);
    };
    const start = Math.max(context.currentTime + 0.025, track.nextTime);
    track.nextTime = start + buffer.duration;
    source.start(start);
    if (context.state !== 'running')
      void context.resume().catch(() => this.publish());
  }

  private drain() {
    const track = this.tracks[0];
    if (!track) return this.publish();
    try {
      for (const chunk of track.chunks.splice(0)) {
        const format = {
          encoding: chunk.encoding,
          mimeType: chunk.mimeType,
          sampleRate: chunk.sampleRate,
          channels: chunk.channels,
        };
        if (
          track.format &&
          JSON.stringify(track.format) !== JSON.stringify(format)
        )
          throw new Error('Audio format changed');
        track.format = format;
        const data = Uint8Array.from(atob(chunk.audio), (character) =>
          character.charCodeAt(0),
        );
        if (chunk.encoding === 'file') {
          track.parts.push(data);
          continue;
        }
        const channels = chunk.channels ?? 1;
        const sampleRate = chunk.sampleRate;
        if (!sampleRate || channels < 1 || channels > 8)
          throw new Error('Invalid PCM format');
        const bytes = new Uint8Array(track.remainder.length + data.length);
        bytes.set(track.remainder);
        bytes.set(data, track.remainder.length);
        const frames = Math.floor(bytes.length / (2 * channels));
        track.remainder = bytes.slice(frames * 2 * channels);
        if (!frames) continue;
        const buffer = this.audioContext().createBuffer(
          channels,
          frames,
          sampleRate,
        );
        const view = new DataView(bytes.buffer);
        for (let channel = 0; channel < channels; channel++) {
          const output = buffer.getChannelData(channel);
          for (let frame = 0; frame < frames; frame++)
            output[frame] =
              view.getInt16((frame * channels + channel) * 2, true) / 32768;
        }
        this.schedule(track, buffer);
      }
      if (
        track.ended &&
        track.format?.encoding === 'file' &&
        !track.decoding &&
        !track.decoded
      ) {
        const bytes = new Uint8Array(
          track.parts.reduce((size, part) => size + part.length, 0),
        );
        let offset = 0;
        for (const part of track.parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        track.parts = [];
        track.decoding = true;
        void this.audioContext()
          .decodeAudioData(bytes.buffer)
          .then((buffer) => {
            if (this.disposed || this.tracks[0] !== track) return;
            track.decoding = false;
            track.decoded = true;
            this.schedule(track, buffer);
            this.finish(track);
          })
          .catch(() => {
            if (this.tracks.includes(track)) this.remove(track, true);
          });
      }
      this.finish(track);
    } catch {
      this.remove(track, true);
    }
  }

  private finish(track: Track) {
    if (track.ended && (track.remainder.length || !track.format))
      return this.remove(track, true);
    if (track.ended && !track.decoding && !track.sources.size)
      return this.remove(track);
    this.publish();
  }

  private remove(track: Track, error = false) {
    for (const source of track.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.tracks = this.tracks.filter((item) => item !== track);
    if (error) this.failed();
    this.drain();
  }

  stop() {
    const tracks = this.tracks;
    this.tracks = [];
    for (const track of tracks) {
      for (const source of track.sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
    }
    this.publish();
  }
  private stopWithError() {
    this.stop();
    this.failed();
  }
  dispose() {
    this.stop();
    this.disposed = true;
    this.analyser?.disconnect();
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
    }
  }
}
