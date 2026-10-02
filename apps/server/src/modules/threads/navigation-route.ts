import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '@aime/auth';
import type { ThreadService } from './service.js';

export function streamThreadNavigation(
  auth: Auth,
  service: ThreadService,
  req: Request,
  res: Response,
) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  const unsubscribe = service.subscribeNavigation(
    res.locals.userId,
    (event) => {
      if (closed) return;
      if (res.writableLength > 2 * 1024 * 1024) {
        res.end();
        return;
      }
      res.write(`event: navigation\ndata: ${JSON.stringify(event)}\n\n`);
    },
    () => res.end(),
  );
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, 15_000);
  const authorization = setInterval(() => {
    void auth.api
      .getSession({ headers: fromNodeHeaders(req.headers) })
      .then((session) => {
        if (closed) return;
        if (!session || session.user.id !== res.locals.userId) {
          res.write('event: expired\ndata: {}\n\n');
          res.end();
        }
      })
      .catch(() => {
        if (!closed) res.end();
      });
  }, 60_000);
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    clearInterval(authorization);
    unsubscribe();
  });
}
