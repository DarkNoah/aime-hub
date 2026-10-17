import { randomUUID } from 'node:crypto';
import type { SpeechEvent } from '@aime/shared/audio';
import type { SpeechAudioChunk } from '../../mastra/providers/speech-model.js';

type SpeechJob = {
  text: string;
  toolCallId?: string;
  timeoutMs: number;
  generate: (
    signal: AbortSignal,
    emit: (chunk: SpeechAudioChunk) => Promise<void>,
  ) => Promise<void>;
};

/** Session-owned jobs outlive a tool result and LLM turn, but never a closed session. */
export class SpeechPlayback {
  private jobs = new Map<string, AbortController>();
  private tail = Promise.resolve();
  private closed = false;
  constructor(
    private readonly emit: (event: SpeechEvent) => void | Promise<void>,
  ) {}
  get active() {
    return this.jobs.size > 0;
  }

  start(job: SpeechJob) {
    if (this.closed) throw new Error('Speech playback session is closed');
    if (this.jobs.size >= 16) throw new Error('Speech playback queue is full');
    const playbackId = randomUUID();
    const controller = new AbortController();
    this.jobs.set(playbackId, controller);
    this.tail = this.tail
      .then(async () => {
        let sequence = 0;
        const send = (
          event: Omit<
            SpeechEvent,
            'playbackId' | 'text' | 'toolCallId' | 'sequence'
          >,
        ) =>
          this.emit({
            ...event,
            playbackId,
            text: job.text,
            toolCallId: job.toolCallId,
            sequence: sequence++,
          } as SpeechEvent);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(job.timeoutMs),
        ]);
        try {
          signal.throwIfAborted();
          await send({ phase: 'start' });
          let size = 0;
          await job.generate(signal, async (chunk) => {
            signal.throwIfAborted();
            size += chunk.data.byteLength;
            if (size > 50_000_000) throw new Error('Speech audio is too large');
            // Keep SSE events bounded, including completed non-streaming audio.
            for (
              let offset = 0;
              offset < chunk.data.byteLength;
              offset += 24576
            ) {
              signal.throwIfAborted();
              await this.emit({
                playbackId,
                text: job.text,
                toolCallId: job.toolCallId,
                sequence: sequence++,
                phase: 'chunk',
                audio: Buffer.from(
                  chunk.data.subarray(offset, offset + 24576),
                ).toString('base64'),
                encoding: chunk.encoding,
                mimeType: chunk.mimeType,
                sampleRate: chunk.sampleRate,
                channels: chunk.channels,
              });
            }
          });
          signal.throwIfAborted();
          if (!size) throw new Error('Empty speech audio');
          this.jobs.delete(playbackId);
          await send({ phase: 'end' });
        } catch {
          this.jobs.delete(playbackId);
          await this.emit({
            playbackId,
            text: job.text,
            toolCallId: job.toolCallId,
            sequence: sequence++,
            ...(controller.signal.aborted
              ? { phase: 'cancelled' as const }
              : {
                  phase: 'error' as const,
                  error: signal.aborted
                    ? ('TIMED_OUT' as const)
                    : ('GENERATION_FAILED' as const),
                }),
          });
        } finally {
          this.jobs.delete(playbackId);
        }
      })
      .catch(() => {
        this.jobs.delete(playbackId);
      });
    return playbackId;
  }
  stop() {
    for (const controller of this.jobs.values()) controller.abort();
  }
  async close() {
    this.closed = true;
    this.stop();
    await this.tail;
  }
  async settled() {
    await this.tail;
  }
}
