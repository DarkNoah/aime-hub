import { Hono } from 'hono';
import type { Auth } from '@aime/auth';
import { requireSession, type HttpEnv } from '../../http.js';
import { eventStream } from '../threads/event-stream.js';
import type { NotificationService } from './service.js';

export function notificationRoutes(auth: Auth, service: NotificationService) {
  const app = new Hono<HttpEnv>();
  app.use('*', requireSession(auth));
  app.get('/events', (c) => {
    const userId = c.get('userId');
    const after = c.req.query('after');
    if (after !== undefined && !/^\d{1,18}$/.test(after))
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const authorized = async () => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      return session?.user.id === userId;
    };
    return eventStream(
      c.req.raw.signal,
      (send, close) =>
        service.subscribe(
          userId,
          after,
          (event) => send('notification', event),
          close,
          authorized,
        ),
      async () => ((await authorized()) ? undefined : 'expired'),
    );
  });
  app.get('/:id', async (c) => {
    const userId = c.get('userId');
    const notification = await service.get(userId, c.req.param('id'));
    return notification
      ? c.json({ userId, notification })
      : c.json({ code: 'NOT_FOUND' }, 404);
  });
  return app;
}
