import { Router, json, type ErrorRequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { z, ZodError } from 'zod';
import type { Auth } from '@aime/auth';
import {
  chatSettingsSchema,
  createThreadSchema,
  runInputSchema,
  updateThreadSchema,
  updateQueuedMessageSchema,
  moveQueuedMessageSchema,
} from '@aime/shared/threads';
import type { ThreadService } from './service.js';
import type { LanguageModelService } from '../models/language-model.js';
import { ThreadError } from './errors.js';
import { adminApiPolicy } from '../../middleware/admin-api.js';
import { streamThreadNavigation } from './navigation-route.js';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{16}$/);
const pagination = z.object({
  page: z.coerce.number().int().min(0).max(10000).default(0),
  anchor: z.iso.datetime().optional(),
  projectId: idSchema.optional(),
  perPage: z.coerce.number().int().min(1).max(50).default(10),
});

export function threadRoutes(
  auth: Auth,
  service: ThreadService,
  models: LanguageModelService,
  webOrigin: string,
) {
  const router = Router();
  router.use(async (req, res, next) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) return res.status(401).json({ code: 'UNAUTHORIZED' });
    res.locals.userId = session.user.id;
    next();
  });
  router.use(adminApiPolicy(webOrigin), json({ limit: '12mb' }));
  router.get('/events', (req, res) =>
    streamThreadNavigation(auth, service, req, res),
  );
  router.get('/preferences', async (_req, res) =>
    res.json(await models.getPreferences(res.locals.userId)),
  );
  router.put('/preferences', async (req, res) =>
    res.json(
      await models.setPreferences(
        res.locals.userId,
        chatSettingsSchema.parse(req.body),
      ),
    ),
  );
  router.get('/', async (req, res) => {
    const { page, projectId, perPage } = pagination.parse(req.query);
    res.json(
      await service.listThreads(res.locals.userId, page, projectId, perPage),
    );
  });
  router.post('/', async (req, res) =>
    res
      .status(201)
      .json(
        await service.createThread(
          res.locals.userId,
          createThreadSchema.parse(req.body),
        ),
      ),
  );
  router.param('threadId', (req, _res, next) => {
    const parsed = idSchema.safeParse(req.params.threadId);
    if (!parsed.success) return next(new ThreadError('THREAD_NOT_FOUND', 404));
    next();
  });
  router.get('/:threadId', async (req, res) =>
    res.json(
      await service.getThread(res.locals.userId, String(req.params.threadId)),
    ),
  );
  router.patch('/:threadId', async (req, res) =>
    res.json(
      await service.updateThread(
        res.locals.userId,
        String(req.params.threadId),
        updateThreadSchema.parse(req.body),
      ),
    ),
  );
  router.delete('/:threadId', async (req, res) => {
    await service.deleteThread(res.locals.userId, String(req.params.threadId));
    res.status(204).end();
  });
  router.get('/:threadId/history', async (req, res) => {
    const { page, anchor } = pagination.parse(req.query);
    res.json(
      await service.history(
        res.locals.userId,
        String(req.params.threadId),
        page,
        anchor,
      ),
    );
  });
  router.post('/:threadId/messages', async (req, res) =>
    res.status(202).json(
      await service.run(res.locals.userId, String(req.params.threadId), {
        ...runInputSchema.parse(req.body),
        createdBy: res.locals.userId,
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  router.post('/:threadId/abort', async (req, res) =>
    res.json(
      await service.abort(res.locals.userId, String(req.params.threadId)),
    ),
  );
  router.post('/:threadId/resume', async (req, res) =>
    res.json(
      await service.resume(res.locals.userId, String(req.params.threadId)),
    ),
  );
  router.get('/:threadId/queue/:messageId', async (req, res) =>
    res.json(
      await service.getQueued(
        res.locals.userId,
        String(req.params.threadId),
        String(req.params.messageId),
      ),
    ),
  );
  router.patch('/:threadId/queue/:messageId', async (req, res) =>
    res.json(
      await service.updateQueued(
        res.locals.userId,
        String(req.params.threadId),
        String(req.params.messageId),
        updateQueuedMessageSchema.parse(req.body),
      ),
    ),
  );
  router.patch('/:threadId/queue', async (req, res) => {
    const input = moveQueuedMessageSchema.parse(req.body);
    res.json(
      await service.moveQueued(
        res.locals.userId,
        String(req.params.threadId),
        input.id,
        input.beforeId,
      ),
    );
  });
  router.delete('/:threadId/queue/:messageId', async (req, res) =>
    res.json(
      await service.cancelQueued(
        res.locals.userId,
        String(req.params.threadId),
        String(req.params.messageId),
      ),
    ),
  );
  router.get('/:threadId/messages', async (req, res) => {
    // Authenticate and authorize before opening the SSE response.
    await service.getThread(res.locals.userId, String(req.params.threadId));
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': heartbeat\n\n');
    }, 15_000);
    const authorization = setInterval(() => {
      void auth.api
        .getSession({ headers: fromNodeHeaders(req.headers) })
        .then(async (session) => {
          if (!session) {
            res.write('event: expired\ndata: {}\n\n');
            res.end();
            return;
          }
          await service.getThread(session.user.id, String(req.params.threadId));
        })
        .catch(() => {
          if (!closed) res.write('event: revoked\ndata: {}\n\n');
          res.end();
        });
    }, 60_000);
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      clearInterval(authorization);
      unsubscribe?.();
    };
    res.on('close', cleanup);
    try {
      unsubscribe = await service.subscribe(
        res.locals.userId,
        String(req.params.threadId),
        (snapshot, initial) => {
          if (closed) return;
          // A slow client reconnects to a current snapshot rather than retaining unbounded buffers.
          if (res.writableLength > 2 * 1024 * 1024) {
            res.end();
            return;
          }
          res.write(
            `event: ${initial ? 'snapshot' : 'update'}\ndata: ${JSON.stringify(snapshot)}\n\n`,
          );
        },
        () => {
          if (!closed) res.write('event: revoked\ndata: {}\n\n');
          res.end();
        },
      );
      if (closed) unsubscribe();
    } catch {
      cleanup();
      res.end();
    }
  });
  router.use(threadErrorHandler);
  return router;
}

export const threadErrorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (error instanceof ThreadError)
    return res.status(error.status).json({ code: error.code });
  if (
    error instanceof ZodError ||
    (error instanceof SyntaxError && 'body' in error)
  )
    return res.status(400).json({ code: 'VALIDATION_ERROR' });
  if (error?.type === 'entity.too.large')
    return res.status(413).json({ code: 'MESSAGE_TOO_LARGE' });
  next(error);
};
