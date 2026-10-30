import { randomUUID } from '@aime/shared/uuid';
import type {
  RealtimeEvent,
  RealtimeSubscription,
} from '@aime/shared/realtime';
import { RealtimeBroker } from './broker';
import type { RealtimeBridge } from './protocol';

type Message =
  | { type: 'leader' }
  | { type: 'state'; peer: string; subscriptions: RealtimeSubscription[] }
  | { type: 'leave'; peer: string }
  | { type: 'event'; peer: string; event: RealtimeEvent };

/** SharedWorker fallback: a Web Lock elects exactly one connection-owning tab. */
export function createTabBridge(
  sessionId: string,
  receive: (event: RealtimeEvent) => void,
): RealtimeBridge {
  const peer = randomUUID();
  // HTTP LAN origins lack Web Locks. Keep one connection per tab when
  // cross-tab coordination is unavailable.
  if (!navigator.locks || typeof BroadcastChannel === 'undefined') {
    const broker = new RealtimeBroker(sessionId);
    return {
      update: (subscriptions) => broker.update(peer, subscriptions, receive),
      close: () => broker.close(),
    };
  }
  const name = `realtime-v1:${sessionId}`;
  const channel = new BroadcastChannel(name);
  const abort = new AbortController();
  let subscriptions: RealtimeSubscription[] = [];
  let broker: RealtimeBroker | undefined;
  let release: (() => void) | undefined;
  let closed = false;
  const seen = new Map<string, number>();
  const post = (message: Message) => channel.postMessage(message);
  const sendState = () => {
    if (closed) return;
    broker?.update(peer, subscriptions, receive);
    post({ type: 'state', peer, subscriptions });
  };
  channel.onmessage = ({ data }: MessageEvent<Message>) => {
    if (data.type === 'leader') return sendState();
    if (data.type === 'event') {
      if (data.peer === peer) receive(data.event);
    } else if (data.type === 'state' && broker) {
      seen.set(data.peer, Date.now());
      broker.update(data.peer, data.subscriptions, (event) =>
        post({ type: 'event', peer: data.peer, event }),
      );
    } else if (data.type === 'leave') {
      seen.delete(data.peer);
      broker?.remove(data.peer);
    }
  };
  const heartbeat = setInterval(() => {
    sendState();
    for (const [id, lastSeen] of seen) {
      if (Date.now() - lastSeen > 180_000) {
        seen.delete(id);
        broker?.remove(id);
      }
    }
  }, 30_000);
  void navigator.locks
    .request(name, { signal: abort.signal }, async () => {
      if (closed) return;
      broker = new RealtimeBroker(sessionId);
      broker.update(peer, subscriptions, receive);
      post({ type: 'leader' });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      broker.close();
      broker = undefined;
    })
    .catch(() => {
      /* A closing tab cancels its pending leadership request. */
    });
  return {
    update(next) {
      subscriptions = next;
      sendState();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      post({ type: 'leave', peer });
      broker?.close();
      release?.();
      abort.abort();
      channel.close();
    },
  };
}
