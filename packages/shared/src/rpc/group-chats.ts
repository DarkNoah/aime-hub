import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, threadId, page, perPage, id } from './base.js';
import {
  groupChatCreateSchema,
  groupChatMessageSchema,
  type GroupChat,
  type GroupChatDetail,
  type GroupChatList,
  type GroupChatMessage,
  type GroupChatMessages,
  type MemberProfile,
} from '../group-chats.js';

const params = z.object({ roomId: threadId });
const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const groupChatMessagesQuery = z
  .object({
    before: sequence.optional(),
    after: sequence.optional(),
    limit: perPage.default(50),
  })
  .refine((value) => !(value.before && value.after));

export const groupChatsContract = {
  openDefault: procedure
    .route({
      method: 'POST',
      path: '/group-chats/default',
      inputStructure: 'detailed',
    })
    .input(z.object({ body: z.object({ projectId: threadId.optional() }) }))
    .output(type<GroupChatDetail>()),
  list: procedure
    .route({ method: 'GET', path: '/group-chats', inputStructure: 'detailed' })
    .input(
      z.object({
        query: z.object({
          projectId: threadId.optional(),
          page,
          perPage: perPage.default(20),
        }),
      }),
    )
    .output(type<GroupChatList>()),
  create: procedure
    .route({
      method: 'POST',
      path: '/group-chats',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: groupChatCreateSchema }))
    .output(type<GroupChatDetail>()),
  get: procedure
    .route({
      method: 'GET',
      path: '/group-chats/{roomId}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(type<GroupChatDetail>()),
  update: procedure
    .route({
      method: 'PATCH',
      path: '/group-chats/{roomId}',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params, body: groupChatCreateSchema.pick({ title: true }) }),
    )
    .output(type<GroupChat>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: '/group-chats/{roomId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params }))
    .output(type<void>()),
  messages: procedure
    .route({
      method: 'GET',
      path: '/group-chats/{roomId}/messages',
      inputStructure: 'detailed',
    })
    .input(z.object({ params, query: groupChatMessagesQuery }))
    .output(type<GroupChatMessages>()),
  send: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/messages',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ params, body: groupChatMessageSchema }))
    .output(type<GroupChatMessage>()),
};

export const usersContract = {
  lookup: procedure
    .route({
      method: 'POST',
      path: '/users/lookup',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        body: z.object({
          userIds: z.array(id).max(100),
          roomId: threadId.optional(),
        }),
      }),
    )
    .output(type<MemberProfile[]>()),
};
