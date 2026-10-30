import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, threadId, page, perPage, id } from './base.js';
import {
  groupChatCreateSchema,
  groupChatSequenceSchema,
  groupChatReadSchema,
  type GroupChatReadState,
  groupChatMessageSchema,
  groupChatAgentCreateSchema,
  groupChatAgentUpdateSchema,
  groupChatReactionSchema,
  groupChatUiResponseSchema,
  groupChatA2aMemberCreateSchema,
  groupChatA2aMemberUpdateSchema,
  type GroupChatA2AMember,
  type GroupChatAgent,
  type GroupChatEvent,
  type GroupChatSearch,
  type GroupChat,
  type GroupChatDetail,
  type GroupChatList,
  type GroupChatMessage,
  type GroupChatMessages,
  type MemberProfile,
} from '../group-chats.js';

const params = z.object({ roomId: threadId });
const sequence = groupChatSequenceSchema;
export const groupChatMessagesQuery = z
  .object({
    before: sequence.optional(),
    after: sequence.optional(),
    afterRevision: sequence.optional(),
    limit: perPage.default(50),
  })
  .refine(
    (value) =>
      [value.before, value.after, value.afterRevision].filter(
        (value) => value !== undefined,
      ).length <= 1,
  );

export const groupChatsContract = {
  unread: procedure
    .route({
      method: 'GET',
      path: '/group-chats/unread',
      inputStructure: 'detailed',
    })
    .input(z.object({}))
    .output(type<{ rooms: GroupChatReadState[] }>()),
  markRead: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/read',
      inputStructure: 'detailed',
    })
    .input(z.object({ params, body: groupChatReadSchema }))
    .output(type<{ readSequence: string }>()),
  createA2aMember: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/a2a-members',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ params, body: groupChatA2aMemberCreateSchema }))
    .output(type<{ member: GroupChatA2AMember; apiKey: string }>()),
  updateA2aMember: procedure
    .route({
      method: 'PATCH',
      path: '/group-chats/{roomId}/a2a-members/{memberId}',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: params.extend({ memberId: threadId }),
        body: groupChatA2aMemberUpdateSchema,
      }),
    )
    .output(type<GroupChatA2AMember>()),
  revokeA2aMember: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/a2a-members/{memberId}/revoke',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: params.extend({ memberId: threadId }) }))
    .output(type<GroupChatA2AMember>()),
  removeA2aMember: procedure
    .route({
      method: 'DELETE',
      path: '/group-chats/{roomId}/a2a-members/{memberId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: params.extend({ memberId: threadId }) }))
    .output(type<void>()),
  searchUsers: procedure
    .route({
      method: 'GET',
      path: '/group-chats/{roomId}/users',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params, query: z.object({ query: z.string().max(200) }) }),
    )
    .output(type<MemberProfile[]>()),
  addMember: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/members',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ params, body: z.object({ userId: id }) }))
    .output(type<MemberProfile>()),
  addAgent: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/agents',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ params, body: groupChatAgentCreateSchema }))
    .output(type<GroupChatAgent>()),
  updateAgent: procedure
    .route({
      method: 'PATCH',
      path: '/group-chats/{roomId}/agents/{agentId}',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: params.extend({ agentId: threadId }),
        body: groupChatAgentUpdateSchema,
      }),
    )
    .output(type<GroupChatAgent>()),
  removeAgent: procedure
    .route({
      method: 'DELETE',
      path: '/group-chats/{roomId}/agents/{agentId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: params.extend({ agentId: threadId }) }))
    .output(type<void>()),
  react: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/messages/{messageId}/reactions',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: params.extend({ messageId: id }),
        body: groupChatReactionSchema,
      }),
    )
    .output(type<GroupChatMessage>()),
  respondUi: procedure
    .route({
      method: 'POST',
      path: '/group-chats/{roomId}/messages/{messageId}/responses',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(
      z.object({
        params: params.extend({ messageId: id }),
        body: groupChatUiResponseSchema,
      }),
    )
    .output(type<GroupChatMessage>()),
  search: procedure
    .route({
      method: 'GET',
      path: '/group-chats/{roomId}/search',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params,
        query: z.object({
          query: z.string().trim().max(2000).optional(),
          reactions: z
            .array(groupChatReactionSchema.shape.emoji)
            .max(20)
            .optional(),
          limit: perPage.default(20),
        }),
      }),
    )
    .output(type<GroupChatSearch>()),
  plans: procedure
    .route({
      method: 'GET',
      path: '/group-chats/{roomId}/plans',
      inputStructure: 'detailed',
    })
    .input(z.object({ params }))
    .output(type<GroupChatEvent[]>()),
  cancelPlan: procedure
    .route({
      method: 'DELETE',
      path: '/group-chats/{roomId}/plans/{eventId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: params.extend({ eventId: id }) }))
    .output(type<void>()),
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
