import { Hono } from 'hono';
import type { Auth } from '@aime/auth';
import { requireSession, type HttpEnv } from '../../http.js';
import type { ThreadService } from './service.js';
import { streamThreadNavigation } from './navigation-route.js';
import { eventStream } from './event-stream.js';
import { fileRoutes } from '../files/routes.js';
import { ThreadError } from './errors.js';

export function threadRoutes(auth: Auth, service: ThreadService) {
  const router = new Hono<HttpEnv>();
  router.get('/events', requireSession(auth), (c) =>
    streamThreadNavigation(auth, service, c.req.raw, c.get('userId')),
  );
  router.route('/:threadId/files', fileRoutes(auth, service));
  router.get('/:threadId/messages', requireSession(auth), async (c) => {
    const userId = c.get('userId');
    const threadId = c.req.param('threadId');
    if (!/^[a-zA-Z0-9_-]{16}$/.test(threadId))
      throw new ThreadError('THREAD_NOT_FOUND', 404);
    await service.getThread(userId, threadId);
    return eventStream(
      c.req.raw.signal,
      (send, close) =>
        service.subscribe(
          userId,
          threadId,
          (snapshot, initial) =>
            send(initial ? 'snapshot' : 'update', snapshot),
          () => {
            send('revoked', {});
            close();
          },
        ),
      async () => {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
        if (!session || session.user.id !== userId) return 'expired';
        try {
          await service.getThread(userId, threadId);
        } catch {
          return 'revoked';
        }
      },
    );
  });
  return router;
}
