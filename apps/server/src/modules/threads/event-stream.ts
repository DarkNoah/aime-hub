type Send = (event: string, data: unknown) => void;
type Subscribe = (
  send: Send,
  close: () => void,
  sendStreaming: (event: string, data: unknown) => Promise<void>,
) => (() => void) | Promise<() => void>;

// Bound each subscriber's queue. Disconnecting only removes the observer; the
// persisted runner continues, and reconnecting obtains a fresh snapshot.
export function eventStream(
  signal: AbortSignal,
  subscribe: Subscribe,
  authorize: () => Promise<'expired' | 'revoked' | undefined>,
) {
  let close = () => {};
  const drainWaiters = new Set<() => void>();
  const drain = () => {
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        let checking = false;
        const write = (value: string) => {
          if (closed) return;
          const bytes = encoder.encode(value);
          // Permit one complete snapshot even when it contains a large attachment.
          // Close on subsequent writes if the consumer has stopped draining it.
          if ((controller.desiredSize ?? 0) <= 0) return close();
          controller.enqueue(bytes);
        };
        const send: Send = (event, data) =>
          write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // Audio producers await transport capacity rather than filling the SSE queue
        // with a completed non-streaming file in a single microtask burst.
        const sendStreaming = async (event: string, data: unknown) => {
          while (!closed && (controller.desiredSize ?? 0) <= 0) {
            const timeout = setTimeout(close, 5_000);
            try {
              await new Promise<void>((resolve) => drainWaiters.add(resolve));
            } finally {
              clearTimeout(timeout);
            }
          }
          if (!closed) send(event, data);
        };
        const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
        const authorization = setInterval(() => {
          if (checking || closed) return;
          checking = true;
          void authorize()
            .then((reason) => {
              if (reason) {
                send(reason, {});
                close();
              }
            })
            .catch(close)
            .finally(() => {
              checking = false;
            });
        }, 60_000);
        close = () => {
          if (closed) return;
          closed = true;
          drain();
          clearInterval(heartbeat);
          clearInterval(authorization);
          signal.removeEventListener('abort', close);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* Already cancelled by the reader. */
          }
        };
        signal.addEventListener('abort', close, { once: true });
        if (signal.aborted) {
          close();
          return;
        }
        // Flush headers even when the first snapshot needs asynchronous storage.
        write(': connected\n\n');
        void Promise.resolve()
          .then(() =>
            closed ? () => {} : subscribe(send, close, sendStreaming),
          )
          .then((stop) => {
            unsubscribe = stop;
            if (closed) stop();
          })
          .catch(close);
      },
      pull() {
        drain();
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: 2 * 1024 * 1024, size: (chunk) => chunk.byteLength },
  );
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
