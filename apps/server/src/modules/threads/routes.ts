import { Hono } from 'hono';
import type { Auth } from '@aime/auth';
import { requireSession, type HttpEnv } from '../../http.js';
import type { ThreadService } from './service.js';
import { streamThreadNavigation } from './navigation-route.js';
import { eventStream } from './event-stream.js';
import { fileRoutes } from '../files/routes.js';
import { ThreadError } from './errors.js';

export function threadRoutes(
  auth: Auth,
  service: ThreadService,
  webOrigins: readonly string[] = [],
) {
  const router = new Hono<HttpEnv>();
  router.get('/events', requireSession(auth), (c) =>
    streamThreadNavigation(auth, service, c.req.raw, c.get('userId')),
  );
  router.route('/:threadId/files', fileRoutes(auth, service, webOrigins));
  router.get(
    '/:threadId/turns/:turnId/media',
    requireSession(auth),
    async (c) => {
      const index = (name: string) => {
        const value = c.req.query(name);
        if (value === undefined) return undefined;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0)
          throw new ThreadError('VALIDATION_ERROR');
        return parsed;
      };
      const media = await service.getTurnMedia(
        c.get('userId'),
        c.req.param('threadId'),
        c.req.param('turnId'),
        {
          messageId: c.req.query('messageId') ?? '',
          partIndex: index('partIndex'),
          toolCallId: c.req.query('toolCallId'),
          contentIndex: index('contentIndex'),
        },
        c.req.query('cursor'),
      );
      const headers = new Headers({
        'Content-Type': /^[\w.+-]+\/[\w.+-]+$/.test(media.mediaType)
          ? media.mediaType
          : 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Accept-Ranges': 'bytes',
      });
      // Native media elements can request a byte range when seeking legacy audio.
      const range = c.req.header('Range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const length = media.data.length;
        const start = match?.[1]
          ? Number(match[1])
          : Math.max(0, length - Number(match?.[2]));
        const end =
          match?.[1] && match[2]
            ? Math.min(Number(match[2]), length - 1)
            : length - 1;
        if (
          !match ||
          (!match[1] && !match[2]) ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          start >= length
        ) {
          headers.set('Content-Range', `bytes */${length}`);
          return new Response(null, { status: 416, headers });
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${length}`);
        headers.set('Content-Length', String(end - start + 1));
        return new Response(
          new Uint8Array(media.data.subarray(start, end + 1)),
          { status: 206, headers },
        );
      }
      headers.set('Content-Length', String(media.data.length));
      return new Response(new Uint8Array(media.data), { headers });
    },
  );
  router.get('/:threadId/browser/events', requireSession(auth), async (c) => {
    const userId = c.get('userId');
    const threadId = c.req.param('threadId');
    if (!/^(?:schedule:)?[a-zA-Z0-9_-]{16}$/.test(threadId))
      throw new ThreadError('THREAD_NOT_FOUND', 404);
    await service.getBrowserState(userId, threadId);
    const response = eventStream(
      c.req.raw.signal,
      (send) =>
        service.subscribeBrowser(userId, threadId, (event) =>
          send(event.type, event.type === 'frame' ? event.frame : event.state),
        ),
      async () => {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
        if (!session || session.user.id !== userId) return 'expired';
        try {
          await service.getBrowserState(userId, threadId);
        } catch {
          return 'revoked';
        }
      },
    );
    response.headers.set('Cache-Control', 'no-store, no-transform');
    return response;
  });
  router.get('/:threadId/messages', requireSession(auth), async (c) => {
    const userId = c.get('userId');
    const threadId = c.req.param('threadId');
    if (!/^(?:schedule:)?[a-zA-Z0-9_-]{16}$/.test(threadId))
      throw new ThreadError('THREAD_NOT_FOUND', 404);
    await service.getThreadSummary(userId, threadId);
    const summary = c.req.query('view') === 'summary';
    return eventStream(
      c.req.raw.signal,
      (send, close, sendStreaming) =>
        service.subscribe(
          userId,
          threadId,
          (snapshot, initial) => {
            if (!summary) send(initial ? 'snapshot' : 'update', snapshot);
          },
          (code) => {
            send('revoked', { code: code ?? 'PROJECT_NOT_FOUND' });
            close();
          },
          (event) => sendStreaming('speech', event),
          summary
            ? (snapshot, initial) =>
                send(initial ? 'snapshot' : 'update', snapshot)
            : undefined,
        ),
      async () => {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
        if (!session || session.user.id !== userId) return 'expired';
        try {
          await service.getThreadSummary(userId, threadId);
        } catch {
          return 'revoked';
        }
      },
    );
  });
  return router;
}
