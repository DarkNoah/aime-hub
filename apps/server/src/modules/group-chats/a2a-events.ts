import { ORPCError } from '@orpc/server';
import type { GroupChatMessages } from '@aime/shared/group-chats';

/** Persistent revision cursors work across reconnects and server processes. */
export function roomMessagesStream(
  signal: AbortSignal,
  load: (afterRevision: string) => Promise<GroupChatMessages>,
  afterRevision: string,
) {
  let stop = () => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cursor = afterRevision;
        let first = true;
        let lastWrite = Date.now();
        stop = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
          try {
            controller.close();
          } catch {
            /* Reader already cancelled. */
          }
        };
        const write = (text: string) => {
          if (stopped) return;
          // Bound each observer to one page when the consumer stops reading.
          if ((controller.desiredSize ?? 0) <= 0) return stop();
          controller.enqueue(encoder.encode(text));
          lastWrite = Date.now();
        };
        const poll = async () => {
          try {
            // load authenticates inside the same transaction as the read. Revoked
            // keys and removed sponsors cannot receive the next page.
            const page = await load(cursor);
            if (stopped) return;
            if (first || page.messages.length || page.revision !== cursor) {
              write(
                `event: messages\nid: ${page.revision}\ndata: ${JSON.stringify(page)}\n\n`,
              );
              cursor = page.revision;
              first = false;
            } else if (Date.now() - lastWrite >= 15_000) {
              write(': heartbeat\n\n');
            }
            if (!stopped)
              timer = setTimeout(() => void poll(), page.hasMore ? 0 : 2_500);
          } catch (error) {
            const revoked =
              error instanceof ORPCError &&
              ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code);
            write(
              revoked
                ? 'event: revoked\ndata: {}\n\n'
                : 'event: error\ndata: {"code":"UNAVAILABLE"}\n\n',
            );
            stop();
          }
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) return stop();
        write(': connected\n\n');
        void poll();
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength },
  );
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
