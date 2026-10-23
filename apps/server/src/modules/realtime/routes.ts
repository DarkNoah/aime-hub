import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Auth } from '@aime/auth';
import type { HttpEnv } from '../../http.js';
import { eventStream } from '../threads/event-stream.js';
import { RealtimeConnection } from './connection.js';

const idSchema = z.string().uuid();
// Never turn the multiplex endpoint into a general-purpose authenticated proxy.
const feedUrl =
  /^(?:\/api\/threads\/events|\/api\/notifications\/events(?:\?after=\d{1,18})?|\/api\/threads\/(?:schedule(?::|%3A))?[a-zA-Z0-9_-]{16}\/(?:messages\?view=summary|browser\/events))$/;
const configurationSchema = z
  .object({
    generation: idSchema,
    revision: z.number().int().nonnegative(),
    subscriptions: z
      .array(z.object({ id: idSchema, url: z.string().regex(feedUrl) }))
      .max(256),
  })
  .refine(
    ({ subscriptions }) =>
      new Set(subscriptions.map((s) => s.id)).size === subscriptions.length,
  );

export function realtimeRoutes(
  auth: Auth,
  dispatch: (request: Request) => Response | Promise<Response>,
  webOrigins: readonly string[],
) {
  const router = new Hono<HttpEnv>();
  const connections = new Map<string, RealtimeConnection>();
  router.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  router.all('/:id', async (c) => {
    if (!['GET', 'POST'].includes(c.req.method))
      return c.json({ code: 'METHOD_NOT_SUPPORTED' }, 405);
    if (
      c.req.method === 'POST' &&
      !webOrigins.includes(c.req.header('Origin') ?? '')
    )
      return c.json({ code: 'FORBIDDEN' }, 403);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session || c.req.query('session') !== session.session.id)
      return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (!idSchema.safeParse(c.req.param('id')).success)
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    const key = `${session.user.id}:${session.session.id}:${c.req.param('id')}`;
    if (c.req.method === 'POST') {
      const parsed = configurationSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
      if (!connections.get(key)?.configure(parsed.data))
        return c.json({ code: 'REALTIME_RECONNECT' }, 409);
      return c.json({ ok: true });
    }
    return eventStream(
      c.req.raw.signal,
      (send, close, sendStreaming) => {
        // Register atomically inside subscribe, which runs asynchronously. Two
        // concurrent reconnects must never leave the previous observer alive.
        connections.get(key)?.close();
        const connection = new RealtimeConnection(
          (url, signal) =>
            Promise.resolve(
              dispatch(
                new Request(new URL(url, c.req.url), {
                  headers: c.req.raw.headers,
                  signal,
                }),
              ),
            ),
          (event) => sendStreaming('event', event),
          close,
        );
        connections.set(key, connection);
        send('ready', { generation: connection.generation });
        return () => {
          connection.close();
          if (connections.get(key) === connection) connections.delete(key);
        };
      },
      async () => {
        const current = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
        return current?.session.id === session.session.id &&
          current.user.id === session.user.id
          ? undefined
          : 'expired';
      },
    );
  });
  return router;
}
