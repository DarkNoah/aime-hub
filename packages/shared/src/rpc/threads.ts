import { type } from '@orpc/contract';
import { z } from 'zod';
import { procedure, id, threadId, page, perPage } from './base.js';
import {
  chatSettingsSchema,
  createThreadSchema,
  runInputSchema,
  updateThreadSchema,
  toolResponseSchema,
  updateQueuedMessageSchema,
  moveQueuedMessageSchema,
  type QueuedMessageDetail,
  type ChatSettings,
  type ChatSkill,
  type ThreadList,
  type ThreadSummary,
  type ThreadSnapshot,
  type MessagePage,
} from '../threads.js';
import type { UIMessage } from 'ai';
import type { ChatTurnDetail, ChatTurnPage } from '../chat-turns.js';
import { browserContract } from './browser.js';

export const threadsContract = {
  browser: browserContract,
  archived: procedure
    .route({
      method: 'GET',
      path: '/threads/archived',
      inputStructure: 'detailed',
    })
    .output(type<ThreadSummary[]>()),
  restore: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/restore',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<ThreadSummary>()),
  removeArchived: procedure
    .route({
      method: 'DELETE',
      path: '/threads/archived/{threadId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<void>()),
  list: procedure
    .route({ method: 'GET', path: '/threads', inputStructure: 'detailed' })
    .input(
      z.object({
        query: z.object({
          page,
          perPage: perPage.default(10),
          projectId: threadId.optional(),
          plugin: createThreadSchema.shape.plugin,
        }),
      }),
    )
    .output(type<ThreadList>()),
  create: procedure
    .route({
      method: 'POST',
      path: '/threads',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(z.object({ body: createThreadSchema }))
    .output(type<ThreadSummary>()),
  get: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<ThreadSnapshot<UIMessage>>()),
  update: procedure
    .route({
      method: 'PATCH',
      path: '/threads/{threadId}',
      inputStructure: 'detailed',
    })
    .input(
      z.object({ params: z.object({ threadId }), body: updateThreadSchema }),
    )
    .output(type<ThreadSummary>()),
  remove: procedure
    .route({
      method: 'DELETE',
      path: '/threads/{threadId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<void>()),
  skills: procedure
    .route({
      method: 'GET',
      path: '/threads/skills',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        query: z
          .object({
            threadId: threadId.optional(),
            projectId: threadId.optional(),
          })
          .strict(),
      }),
    )
    .output(type<ChatSkill[]>()),
  preferences: procedure
    .route({
      method: 'GET',
      path: '/threads/preferences',
      inputStructure: 'detailed',
    })
    .output(type<ChatSettings>()),
  savePreferences: procedure
    .route({
      method: 'PUT',
      path: '/threads/preferences',
      inputStructure: 'detailed',
    })
    .input(z.object({ body: chatSettingsSchema }))
    .output(type<ChatSettings>()),
  history: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/history',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        query: z.object({
          page,
          anchor: z.iso.datetime().optional(),
          view: z.enum(['full', 'summary']).default('full'),
          cursor: z.string().optional(),
        }),
      }),
    )
    .output(type<MessagePage<UIMessage> | ChatTurnPage>()),
  turn: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/turns/{turnId}',
      inputStructure: 'detailed',
    })
    .input(
      z.object({
        params: z.object({ threadId, turnId: id }),
        query: z.object({ cursor: z.string().optional() }),
      }),
    )
    .output(type<ChatTurnDetail>()),
  run: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/messages',
      inputStructure: 'detailed',
      successStatus: 202,
    })
    .input(z.object({ params: z.object({ threadId }), body: runInputSchema }))
    .output(type<ThreadSummary>()),
  stopSpeech: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/speech/stop',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(z.void()),
  abort: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/abort',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<ThreadSummary>()),
  retry: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/retry',
      inputStructure: 'detailed',
      successStatus: 202,
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<ThreadSummary>()),
  continue: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/continue',
      inputStructure: 'detailed',
      successStatus: 202,
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<ThreadSummary>()),
  compact: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/compact',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(z.object({ observed: z.boolean() })),
  clearGoal: procedure
    .route({
      method: 'DELETE',
      path: '/threads/{threadId}/goal',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<void>()),
  cancelBackgroundTask: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/background-tasks/{taskId}/cancel',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ threadId, taskId: id }) }))
    .output(type<void>()),
  cleanupCommandSession: procedure
    .route({
      method: 'DELETE',
      path: '/threads/{threadId}/command-sessions/{sessionId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(
      z.object({
        params: z.object({
          threadId,
          sessionId: z.coerce.number().int().min(1).max(2_147_483_647),
        }),
      }),
    )
    .output(type<void>()),
  respondToTool: procedure
    .route({
      method: 'POST',
      path: '/threads/{threadId}/tool-interactions/{interactionId}',
      inputStructure: 'detailed',
      successStatus: 202,
    })
    .input(
      z.object({
        params: z.object({ threadId, interactionId: id }),
        body: toolResponseSchema,
      }),
    )
    .output(type<ThreadSummary>()),
  queued: procedure
    .route({
      method: 'GET',
      path: '/threads/{threadId}/queue/{messageId}',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId, messageId: id }) }))
    .output(type<QueuedMessageDetail>()),
  updateQueued: procedure
    .route({
      method: 'PATCH',
      path: '/threads/{threadId}/queue/{messageId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(
      z.object({
        params: z.object({ threadId, messageId: id }),
        body: updateQueuedMessageSchema,
      }),
    )
    .output(type<void>()),
  moveQueued: procedure
    .route({
      method: 'PATCH',
      path: '/threads/{threadId}/queue',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(
      z.object({
        params: z.object({ threadId }),
        body: moveQueuedMessageSchema,
      }),
    )
    .output(type<void>()),
  cancelQueued: procedure
    .route({
      method: 'DELETE',
      path: '/threads/{threadId}/queue/{messageId}',
      inputStructure: 'detailed',
      successStatus: 204,
    })
    .input(z.object({ params: z.object({ threadId, messageId: id }) }))
    .output(type<void>()),
  clearQueue: procedure
    .route({
      method: 'DELETE',
      path: '/threads/{threadId}/queue',
      inputStructure: 'detailed',
    })
    .input(z.object({ params: z.object({ threadId }) }))
    .output(type<ThreadSummary>()),
};
