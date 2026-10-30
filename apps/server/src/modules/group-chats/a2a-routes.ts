import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ORPCError } from '@orpc/server';
import { groupChatMessagesQuery } from '@aime/shared/rpc';
import type { GroupChatService } from './service.js';
import {
  parseRoomA2aMessage,
  parseRoomA2aRequest,
  RoomA2aError,
  roomAgentCard,
  roomIdSchema,
  roomMessageReceipt,
} from './a2a-protocol.js';
import { roomMessagesStream } from './a2a-events.js';

type RoomService = Pick<
  GroupChatService,
  'authenticateA2a' | 'sendA2a' | 'messagesA2a'
>;
type A2aEnv = {
  Variables: {
    apiKey: string;
    identity: Awaited<ReturnType<RoomService['authenticateA2a']>>;
  };
};
const errorResponse = (
  id: string | number | null,
  code: number,
  message: string,
) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message },
});

export function groupChatA2aRoutes(service: RoomService) {
  const router = new Hono<A2aEnv>();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  router.use(
    '*',
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (c) =>
        c.json(errorResponse(null, -32600, 'Request too large'), 413),
    }),
  );
  const authenticate: MiddlewareHandler<A2aEnv> = async (c, next) => {
    const roomId = c.req.param('roomId');
    const key = /^Bearer ([^\s]+)$/i.exec(
      c.req.header('Authorization') ?? '',
    )?.[1];
    if (!key || !roomIdSchema.safeParse(roomId).success) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ code: 'UNAUTHORIZED' }, 401);
    }
    c.set('identity', await service.authenticateA2a(roomId!, key));
    c.set('apiKey', key);
    await next();
  };
  const card = (
    requestUrl: string,
    { room, member }: A2aEnv['Variables']['identity'],
  ) => {
    // The browser's origin survives reverse proxies that rewrite the host.
    // Older keys use the incoming URL, never an unrelated WEB_ORIGINS entry.
    return roomAgentCard(
      room,
      member.publicOrigin ?? new URL(requestUrl).origin,
      member.description,
    );
  };
  router.get('/:roomId/.well-known/agent-card.json', authenticate, (c) =>
    c.json(card(c.req.url, c.get('identity'))),
  );
  router.get('/:roomId/messages', authenticate, async (c) => {
    const parsed = groupChatMessagesQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return c.json(
      await service.messagesA2a(
        c.req.param('roomId'),
        c.get('apiKey'),
        parsed.data,
      ),
    );
  });
  router.get('/:roomId/events', authenticate, (c) => {
    const afterRevision =
      c.req.query('afterRevision') ?? c.req.header('Last-Event-ID') ?? '0';
    const parsed = groupChatMessagesQuery.safeParse({
      afterRevision,
      limit: 50,
    });
    if (
      !parsed.success ||
      c.req.query('after') !== undefined ||
      c.req.query('before') !== undefined
    )
      return c.json({ code: 'VALIDATION_ERROR' }, 400);
    return roomMessagesStream(
      c.req.raw.signal,
      (cursor) =>
        service.messagesA2a(c.req.param('roomId'), c.get('apiKey'), {
          afterRevision: cursor,
          limit: 50,
        }),
      afterRevision,
    );
  });
  router.post('/:roomId', authenticate, async (c) => {
    let id: string | number | null = null;
    try {
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        throw new RoomA2aError(-32700, 'Parse error');
      }
      const request = parseRoomA2aRequest(input);
      id = request.id;
      const version = c.req.header('A2A-Version')?.trim();
      if (version && version !== '0.3')
        throw new RoomA2aError(-32009, 'Only A2A version 0.3 is supported');
      const { member, room } = c.get('identity');
      if (request.method === 'agent/getAuthenticatedExtendedCard')
        return c.json({
          jsonrpc: '2.0',
          id,
          result: card(c.req.url, c.get('identity')),
        });
      if (request.method.startsWith('tasks/pushNotificationConfig/'))
        throw new RoomA2aError(-32003, 'Push notifications are not supported');
      if (
        ['tasks/get', 'tasks/cancel', 'tasks/resubscribe'].includes(
          request.method,
        )
      )
        throw new RoomA2aError(
          -32001,
          'Task not found; room messages do not create tasks',
        );
      if (!['message/send', 'message/stream'].includes(request.method))
        throw new RoomA2aError(-32601, 'Method not found');
      const message = parseRoomA2aMessage(request.params, room.id, member.id);
      const posted = await service.sendA2a(room.id, c.get('apiKey'), message);
      const response = {
        jsonrpc: '2.0',
        id,
        result: roomMessageReceipt(posted),
      };
      if (request.method === 'message/stream')
        return new Response(`data: ${JSON.stringify(response)}\n\n`, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
          },
        });
      return c.json(response);
    } catch (error) {
      if (error instanceof RoomA2aError)
        return c.json(errorResponse(id, error.code, error.message));
      if (error instanceof ORPCError) {
        if (['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code)) {
          c.header('WWW-Authenticate', 'Bearer');
          return c.json(
            errorResponse(id, -32000, 'Room access is unavailable'),
            401,
          );
        }
        if (
          ['BAD_REQUEST', 'VALIDATION_ERROR', 'CONFLICT', 'NOT_FOUND'].includes(
            error.code,
          )
        )
          return c.json(
            errorResponse(
              id,
              -32602,
              'Invalid message or message ID already used',
            ),
          );
      }
      return c.json(errorResponse(id, -32603, 'Internal error'), 500);
    }
  });
  router.onError((error, c) => {
    if (
      error instanceof ORPCError &&
      ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)
    ) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ code: 'UNAUTHORIZED' }, 401);
    }
    return c.json({ code: 'INTERNAL_SERVER_ERROR' }, 500);
  });
  return router;
}
