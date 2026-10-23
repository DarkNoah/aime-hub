import type {
  RealtimeEvent,
  RealtimeSubscription,
} from '@aime/shared/realtime';
import type { RealtimeBridge, WorkerRequest, WorkerResponse } from './protocol';
import { createTabBridge } from './tab-bridge';

const sessions = new Map<string, SharedSession>();

class SharedSession {
  private sources = new Map<string, SharedEventSource>();
  private bridge?: RealtimeBridge;
  private workerFailed = false;
  private lastMessage = Date.now();

  constructor(private sessionId: string) {
    window.addEventListener('pagehide', this.suspend);
    window.addEventListener('pageshow', this.restore);
    document.addEventListener('visibilitychange', this.visible);
  }

  add(source: SharedEventSource) {
    this.sources.set(source.id, source);
    queueMicrotask(() => {
      if (this.sources.has(source.id)) this.sync();
    });
  }

  remove(id: string) {
    this.sources.delete(id);
    if (this.sources.size) this.sync();
    else {
      this.suspend();
      window.removeEventListener('pagehide', this.suspend);
      window.removeEventListener('pageshow', this.restore);
      document.removeEventListener('visibilitychange', this.visible);
      sessions.delete(this.sessionId);
    }
  }

  private suspend = () => {
    this.bridge?.close();
    this.bridge = undefined;
  };
  private resume = () => {
    if (this.sources.size) {
      this.suspend();
      this.sync();
    }
  };
  private restore = (event: PageTransitionEvent) => {
    if (event.persisted || !this.bridge) this.resume();
  };
  private visible = () => {
    if (
      document.visibilityState === 'visible' &&
      Date.now() - this.lastMessage > 90_000
    )
      this.resume();
  };
  private receive = (event: RealtimeEvent) => {
    this.lastMessage = Date.now();
    this.sources.get(event.id)?.receive(event);
  };

  private connect(): RealtimeBridge {
    if (typeof SharedWorker === 'undefined' || this.workerFailed)
      return createTabBridge(this.sessionId, this.receive);
    try {
      const worker = new SharedWorker(
        new URL('./shared-worker.ts', import.meta.url),
        {
          type: 'module',
          name: `realtime-v1:${this.sessionId}`,
        },
      );
      const port = worker.port;
      const post = (message: WorkerRequest) => port.postMessage(message);
      let closed = false;
      const fallback = () => {
        if (closed) return;
        this.workerFailed = true;
        this.resume();
      };
      const startup = setTimeout(fallback, 10_000);
      port.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        this.lastMessage = Date.now();
        if (data.type === 'ready') clearTimeout(startup);
        if (data.type === 'ping') post({ type: 'pong' });
        if (data.type === 'event') this.receive(data.event);
        if (data.type === 'reconnect') this.resume();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fallback();
      };
      port.onmessageerror = fallback;
      port.start();
      return {
        update: (subscriptions: RealtimeSubscription[]) =>
          post({ type: 'update', sessionId: this.sessionId, subscriptions }),
        close: () => {
          closed = true;
          clearTimeout(startup);
          post({ type: 'close' });
          port.close();
        },
      };
    } catch {
      this.workerFailed = true;
      return createTabBridge(this.sessionId, this.receive);
    }
  }

  private sync() {
    this.bridge ??= this.connect();
    this.bridge.update(
      [...this.sources.values()].map(({ id, url }) => ({ id, url })),
    );
  }

  dispose() {
    for (const source of this.sources.values()) source.close();
    this.suspend();
  }
}

/** EventSource-compatible logical observer; closing it never closes another tab. */
export class SharedEventSource extends EventTarget {
  readonly id = crypto.randomUUID();
  onerror: ((event: Event) => void) | null = null;
  private session: SharedSession;
  private closed = false;

  constructor(
    readonly url: string,
    sessionId: string,
  ) {
    super();
    let session = sessions.get(sessionId);
    if (!session) {
      session = new SharedSession(sessionId);
      sessions.set(sessionId, session);
    }
    this.session = session;
    // Register synchronously; connect asynchronously so listeners attach first.
    session.add(this);
  }

  receive(message: RealtimeEvent) {
    if (this.closed) return;
    const event =
      message.event === 'error'
        ? new Event('error')
        : new MessageEvent(message.event, { data: message.data });
    this.dispatchEvent(event);
    if (message.event === 'error') this.onerror?.(event);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.remove(this.id);
  }
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    for (const session of sessions.values()) session.dispose();
  });
