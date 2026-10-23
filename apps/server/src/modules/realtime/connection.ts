import { randomUUID } from 'node:crypto';
import type {
  RealtimeConfiguration,
  RealtimeEvent,
} from '@aime/shared/realtime';

type Open = (url: string, signal: AbortSignal) => Promise<Response>;

/** Opens existing authorized feeds in-process, without additional HTTP sockets. */
export class RealtimeConnection {
  readonly generation = randomUUID();
  private revision = -1;
  private closed = false;
  private channels = new Map<string, { url: string; abort: AbortController }>();

  constructor(
    private open: Open,
    private send: (event: RealtimeEvent) => Promise<void>,
    private disconnect: () => void,
  ) {}

  configure(configuration: RealtimeConfiguration) {
    if (this.closed || configuration.generation !== this.generation)
      return false;
    if (configuration.revision <= this.revision) return true;
    this.revision = configuration.revision;
    const next = new Map(
      configuration.subscriptions.map((item) => [item.id, item]),
    );
    for (const [id, channel] of this.channels) {
      if (next.get(id)?.url === channel.url) continue;
      channel.abort.abort();
      this.channels.delete(id);
    }
    for (const { id, url } of next.values()) {
      if (this.channels.has(id)) continue;
      const abort = new AbortController();
      this.channels.set(id, { url, abort });
      void this.forward(id, url, abort.signal);
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.channels.values()) channel.abort.abort();
    this.channels.clear();
    this.disconnect();
  }

  private async forward(id: string, url: string, signal: AbortSignal) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let terminal = false;
    try {
      const response = await this.open(url, signal);
      if (signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          const body = (await response.json().catch(() => ({}))) as {
            code?: string;
          };
          if (signal.aborted) return;
          terminal = true;
          await this.send({
            id,
            event: response.status === 401 ? 'expired' : 'revoked',
            data: JSON.stringify({ code: body.code ?? 'PROJECT_NOT_FOUND' }),
          });
          return;
        }
        throw new Error(`Realtime feed failed: ${response.status}`);
      }
      if (!response.body) throw new Error('Realtime feed has no body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trimStart();
            if (line.startsWith('data:'))
              data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length || signal.aborted) continue;
          if (event === 'expired' || event === 'revoked') terminal = true;
          await this.send({ id, event, data: data.join('\n') });
        }
      }
    } catch {
      // Reconnecting the transport restores every live feed from its own snapshot.
      if (!signal.aborted && !this.closed) this.disconnect();
      return;
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
    if (!signal.aborted && !terminal && !this.closed) this.disconnect();
  }
}
