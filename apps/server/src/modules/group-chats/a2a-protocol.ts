import { createHash } from 'node:crypto';
import type { AgentCard, Message } from '@mastra/core/a2a/client';
import { z } from 'zod';
import type { GroupChatMessage } from '@aime/shared/group-chats';

export const roomIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{16}$/);
const requestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number().finite(), z.null()]),
  method: z.string(),
  params: z.unknown().optional(),
});
const messageParamsSchema = z.object({
  message: z.object({
    kind: z.literal('message'),
    role: z.literal('user'),
    messageId: z.string().trim().min(1).max(256),
    contextId: z.string().optional(),
    taskId: z.string().optional(),
    parts: z.array(z.object({ kind: z.string() }).passthrough()).min(1),
    metadata: z.object({ replyToId: z.string().optional() }).optional(),
  }),
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
      pushNotificationConfig: z.unknown().optional(),
    })
    .optional(),
});

export class RoomA2aError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseRoomA2aRequest(value: unknown) {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new RoomA2aError(-32600, 'Invalid Request');
  return parsed.data;
}

export function parseRoomA2aMessage(
  value: unknown,
  roomId: string,
  memberId: string,
) {
  const parsed = messageParamsSchema.safeParse(value);
  if (!parsed.success)
    throw new RoomA2aError(-32602, 'Invalid message parameters');
  const { message, configuration } = parsed.data;
  if (message.contextId !== undefined && message.contextId !== roomId)
    throw new RoomA2aError(-32602, 'contextId must identify this room');
  if (message.taskId !== undefined)
    throw new RoomA2aError(
      -32001,
      'Task not found; room messages do not create tasks',
    );
  if (configuration?.pushNotificationConfig != null)
    throw new RoomA2aError(-32003, 'Push notifications are not supported');
  if (
    configuration?.acceptedOutputModes?.length &&
    !configuration.acceptedOutputModes.some((mode) => mode === 'text/plain')
  )
    throw new RoomA2aError(-32005, 'Only text/plain output is supported');
  if (message.parts.some((part) => part.kind !== 'text'))
    throw new RoomA2aError(-32005, 'Only text parts are supported');
  if (message.parts.some((part) => typeof part.text !== 'string'))
    throw new RoomA2aError(-32602, 'Text parts must contain text');
  const text = message.parts
    .map((part) => part.text as string)
    .join('\n')
    .trim();
  if (!text || text.length > 20_000)
    throw new RoomA2aError(
      -32602,
      'Message text must contain 1 to 20000 characters',
    );
  // Client IDs are scoped to a credential identity. Retrying is idempotent, and
  // another member cannot reuse a client ID to overwrite or impersonate it.
  const id = createHash('sha256')
    .update(JSON.stringify([memberId, message.messageId]))
    .digest('hex')
    .slice(0, 32);
  return { id, text, replyToId: message.metadata?.replyToId };
}

export function roomMessageReceipt(message: GroupChatMessage): Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: `receipt-${message.id}`,
    contextId: message.roomId,
    parts: [
      {
        kind: 'text',
        text: 'Message delivered to the room. Read the room message feed for replies.',
      },
    ],
    metadata: {
      roomMessageId: message.id,
      senderId: message.senderId,
      senderName: message.senderName,
      sequence: message.sequence,
      revision: message.revision,
    },
  };
}

export function roomAgentCard(
  room: { id: string; title: string },
  origin: string,
  description?: string,
): AgentCard {
  const url = `${origin}/api/a2a/rooms/${encodeURIComponent(room.id)}`;
  return {
    protocolVersion: '0.3.0',
    name: room.title,
    description:
      description?.trim() ||
      'Participate in this chat room as the member associated with your API key. Sending publishes a message and returns a delivery receipt. Replies are available in the room message feed.',
    url,
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: `${url}/messages`,
          description:
            'Room message history and resumable updates. These HTTP endpoints extend A2A and require the same Bearer key.',
          required: false,
          params: {
            messagesUrl: `${url}/messages`,
            eventsUrl: `${url}/events`,
            cursor: 'afterRevision',
            contextId: room.id,
          },
        },
      ],
    },
    securitySchemes: { roomKey: { type: 'http', scheme: 'bearer' } },
    security: [{ roomKey: [] }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'room-message',
        name: 'Send a room message',
        description:
          'Publish text as your A2A member. Mention a local agent by name to notify it. The receipt confirms delivery, not completion of an agent task.',
        tags: ['chat', 'collaboration'],
        examples: ['Hello everyone', '@Bot Please summarize the discussion'],
      },
    ],
  };
}
