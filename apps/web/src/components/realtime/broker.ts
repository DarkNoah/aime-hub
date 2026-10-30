import { randomUUID } from '@aime/shared/uuid';
import type {
  RealtimeEvent,
  RealtimeSubscription,
} from '@aime/shared/realtime';

export type RealtimeDelivery = RealtimeEvent;
type Peer = {
  subscriptions: RealtimeSubscription[];
  send: (event: RealtimeDelivery) => void;
};

/** Owned by a SharedWorker (or the elected fallback tab), never by a component. */
export class RealtimeBroker {
  private peers = new Map<string, Peer>();
  private source?: EventSource;
  private generation?: string;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private disposed = false;
  private readonly url: string;

  constructor(sessionId: string) {
    this.url = `/api/realtime/${randomUUID()}?session=${encodeURIComponent(sessionId)}`;
  }

  update(
    id: string,
    subscriptions: RealtimeSubscription[],
    send: Peer['send'],
  ) {
    if (this.disposed) return;
    const previous = this.peers.get(id);
    if (
      previous &&
      JSON.stringify(previous.subscriptions) === JSON.stringify(subscriptions)
    ) {
      previous.send = send;
      return;
    }
    if (subscriptions.length) this.peers.set(id, { subscriptions, send });
    else this.peers.delete(id);
    this.revision++;
    if (!this.peers.size) {
      this.disconnect();
      return;
    }
    if (!this.source) this.connect();
    this.schedule();
  }

  remove(id: string) {
    this.update(id, [], () => {});
  }

  close() {
    this.disposed = true;
    this.disconnect();
    this.peers.clear();
  }

  private deliver(message: RealtimeEvent) {
    for (const peer of this.peers.values()) {
      if (
        peer.subscriptions.some(
          (subscription) => subscription.id === message.id,
        )
      ) {
        peer.send(message);
        return;
      }
    }
  }

  private broadcast(event: string) {
    for (const peer of this.peers.values())
      for (const subscription of peer.subscriptions)
        peer.send({ id: subscription.id, event, data: '{}' });
  }

  private connect() {
    const source = new EventSource(this.url);
    this.source = source;
    source.addEventListener('ready', (message) => {
      if (this.source !== source) return;
      this.generation = (
        JSON.parse((message as MessageEvent).data) as { generation: string }
      ).generation;
      this.revision++;
      this.schedule();
    });
    source.addEventListener('event', (message) => {
      if (this.source === source)
        this.deliver(
          JSON.parse((message as MessageEvent).data) as RealtimeEvent,
        );
    });
    source.addEventListener('expired', () => {
      this.broadcast('expired');
      this.disconnect();
    });
    source.onerror = () => {
      if (this.source !== source) return;
      this.generation = undefined;
      this.request?.abort();
      this.broadcast(
        source.readyState === EventSource.CLOSED ? 'expired' : 'error',
      );
      if (source.readyState === EventSource.CLOSED) this.disconnect();
    };
  }

  private disconnect() {
    this.source?.close();
    this.source = undefined;
    this.generation = undefined;
    clearTimeout(this.timer);
    this.request?.abort();
  }

  private schedule(delay = 0) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), delay);
  }

  private async sync() {
    if (!this.generation || this.request || !this.source) return;
    const controller = new AbortController();
    this.request = controller;
    const generation = this.generation;
    const revision = this.revision;
    let failed = false;
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
        body: JSON.stringify({
          generation,
          revision,
          subscriptions: [...this.peers.values()].flatMap(
            (peer) => peer.subscriptions,
          ),
        }),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        this.broadcast('expired');
        this.disconnect();
        return;
      }
      if (response.status === 409) {
        // The server restarted or the previous connection's cleanup won the race.
        this.disconnect();
        if (this.peers.size) this.connect();
        return;
      }
      if (!response.ok) throw new Error('Realtime subscriptions failed');
    } catch {
      failed = !controller.signal.aborted;
      if (failed) this.broadcast('error');
    } finally {
      this.request = undefined;
      if (
        this.generation &&
        (failed || revision !== this.revision || generation !== this.generation)
      )
        this.schedule(failed ? 1000 : 0);
    }
  }
}
