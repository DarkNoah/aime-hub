import { randomUUID } from '@aime/shared/uuid';
import { RealtimeBroker } from './broker';
import type { WorkerRequest, WorkerResponse } from './protocol';

let sessionId: string | undefined;
let broker: RealtimeBroker | undefined;
const ports = new Map<MessagePort, { id: string; seen: number }>();
const send = (port: MessagePort, message: WorkerResponse) =>
  port.postMessage(message);
function remove(port: MessagePort) {
  const peer = ports.get(port);
  if (peer) broker?.remove(peer.id);
  ports.delete(port);
  port.close();
}

// Crashed/frozen pages may never send pagehide. Leases bound orphan subscriptions;
// a resumed page reconnects its port and receives fresh snapshots.
setInterval(() => {
  for (const [port, peer] of ports) {
    if (Date.now() - peer.seen > 120_000) {
      send(port, { type: 'reconnect' });
      remove(port);
    } else send(port, { type: 'ping' });
  }
}, 20_000);

(self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (
  event,
) => {
  const port = event.ports[0];
  const peer = { id: randomUUID(), seen: Date.now() };
  ports.set(port, peer);
  port.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
    peer.seen = Date.now();
    if (data.type === 'close') return remove(port);
    if (data.type !== 'update') return;
    if (sessionId && data.sessionId !== sessionId) return remove(port);
    sessionId = data.sessionId;
    broker ??= new RealtimeBroker(sessionId);
    broker.update(peer.id, data.subscriptions, (message) =>
      send(port, { type: 'event', event: message }),
    );
  };
  port.onmessageerror = () => remove(port);
  port.start();
  send(port, { type: 'ready' });
};
