import { createHash, randomUUID } from 'node:crypto';
import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import { z } from 'zod';
import { intelligentUiInputSchema } from '@aime/shared/intelligent-ui';
import type { AvailableAgents } from '@aime/shared/agents';
import { updateThreadSchema } from '@aime/shared/threads';
import {
  groupChatAgentCreateSchema,
  groupChatAgentUpdateSchema,
  groupChatChoicesSchema,
  roomAgentMention,
} from '@aime/shared/group-chats';
import type { GroupChatService } from '../../modules/group-chats/service.js';
import { BaseTool, toolArray } from '../../modules/tools/base.js';

/** Mounted explicitly with a validated room binding, never in the shared tool catalog. */
export class BotAgentTools extends BaseTool {
  override readonly hidden = true;
  override readonly ids = [
    'send_message',
    'reaction',
    'get_room_info',
    'get_room_messages',
    'search_room_messages',
    'get_room_recent_messages',
    'future_plan',
    'send_ui',
    'room_management',
  ];

  constructor(private readonly room?: GroupChatAgentContext) {
    super();
  }

  protected createTools() {
    if (!this.room) return [];
    return [
      ...toolArray(createGroupChatTools(this.room)),
      ...(this.room.role === 'bot'
        ? [createRoomManagementTool(this.room)]
        : []),
    ];
  }
}

export type GroupChatAgentContext = {
  service: Pick<
    GroupChatService,
    | 'get'
    | 'getAgent'
    | 'sendAgent'
    | 'react'
    | 'messages'
    | 'recentMessages'
    | 'search'
    | 'createPlan'
    | 'addAgent'
    | 'updateAgent'
    | 'removeAgent'
  >;
  availableAgents?: (userId: string) => Promise<AvailableAgents>;
  userId: string;
  roomId: string;
  memberId: string;
  threadId: string;
  role: 'bot' | 'worker';
  memoryPath: string;
};

const abortedMessage = '用户中止了操作';
const pageSize = (value: number | undefined) =>
  Math.max(1, Math.min(50, Math.floor(value ?? 50)));

/** The tool is already bound to its room; preserve the service DTO for other clients. */
function messageWithoutRoom<T extends { roomId: string }>(
  message: T,
): Omit<T, 'roomId'> {
  const result: Omit<T, 'roomId'> & { roomId?: string } = { ...message };
  delete result.roomId;
  return result;
}

/** Stable across native retries of a tool call, scoped to the member's thread. */
function operationId(
  context: GroupChatAgentContext,
  execution: ToolExecutionContext,
  operation: string,
) {
  return createHash('sha256')
    .update(
      `${context.threadId}:${operation}:${execution.agent?.toolCallId ?? randomUUID()}`,
    )
    .digest('hex')
    .slice(0, 32);
}

async function runTool<T>(
  execution: ToolExecutionContext,
  action: () => Promise<T>,
): Promise<T | string> {
  const signal = execution.abortSignal;
  if (signal?.aborted) return abortedMessage;
  let abort: (() => void) | undefined;
  try {
    const pending = action();
    if (!signal) return await pending;
    const cancelled = new Promise<string>((resolve) => {
      abort = () => resolve(abortedMessage);
      signal.addEventListener('abort', abort, { once: true });
      // Cover an abort between the initial check and listener registration.
      if (signal.aborted) abort();
    });
    return await Promise.race([pending, cancelled]);
  } catch (error) {
    if (signal?.aborted) return abortedMessage;
    throw error;
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

function runInRoom<T>(
  context: GroupChatAgentContext,
  execution: ToolExecutionContext,
  action: (userId: string) => Promise<T>,
  botOnly = false,
) {
  return runTool(execution, async () => {
    const actor = execution.requestContext?.get('userId');
    const userId = typeof actor === 'string' ? actor : context.userId;
    const member = await context.service.getAgent(
      userId,
      context.roomId,
      context.memberId,
    );
    if (!member.enabled || member.threadId !== context.threadId)
      throw new Error('This room agent is no longer active.');
    if (botOnly && (context.role !== 'bot' || member.role !== 'bot'))
      throw new Error('Room management is only available to the room bot.');
    if (execution.abortSignal?.aborted) return abortedMessage;
    return action(userId);
  });
}

/** Only the leader mounts this tool; mutations reuse the room service's permissions and lifecycle. */
export function createRoomManagementTool(context: GroupChatAgentContext) {
  const { service, roomId } = context;
  return createTool({
    id: 'room_management',
    title: '房间管理',
    description: `Manage this room's local Agent members. Only the room bot can use this tool, with the current user's existing room management permissions. Inputs are action and args only; the room and acting user are bound by the server.
list_agents: args {}. Returns current members and available Agent configurations (including project/workspace Agents). Use configuration IDs from availableAgents to add or switch an Agent; use memberId from members or get_room_info to update/remove a room member.
add_agent: args {name, settings: {agentId, model?, reasoningEffort?}, enabled?}. Adds a worker with its own dedicated thread. Use the chosen configuration's name by default; model defaults to null and reasoningEffort to auto.
update_agent: args {memberId, name?, settings?: {agentId?, model?, reasoningEffort?}, enabled?, idleWakeHours?}. Only supplied fields change, including within settings. null model restores the configured default. The sole bot cannot be renamed, disabled, switched to another Agent or deleted; only its model, reasoningEffort and idleWakeHours can change. idleWakeHours is bot-only; null disables idle wake-ups. Changing the bot's own model/settings interrupts its current run.
remove_agent: args {memberId}. Removes a worker and its dedicated thread. Does not delete the underlying Agent configuration. Read current members before changing or removing them.`,
    inputSchema: z.object({
      action: z.enum([
        'list_agents',
        'add_agent',
        'update_agent',
        'remove_agent',
      ]),
      args: z.record(z.string(), z.unknown()),
    }),
    execute: async ({ action, args }, execution) =>
      runInRoom(
        context,
        execution,
        async (userId) => {
          if (action === 'list_agents') {
            const room = await service.get(userId, roomId);
            if (execution.abortSignal?.aborted) return abortedMessage;
            if (!context.availableAgents)
              throw new Error(
                'Available Agent configurations cannot be loaded.',
              );
            const catalog = await context.availableAgents(userId);
            return {
              members: room.agents,
              availableAgents: catalog.agents,
              defaultAgentId: catalog.defaultAgentId,
              canManage: room.canManage,
            };
          }
          if (action === 'add_agent')
            return service.addAgent(
              userId,
              roomId,
              groupChatAgentCreateSchema.parse(args),
            );
          const { memberId } = z.object({ memberId: z.string() }).parse(args);
          if (action === 'remove_agent') {
            await service.removeAgent(userId, roomId, memberId);
            return { memberId, removed: true };
          }
          const patch = groupChatAgentUpdateSchema
            .extend({
              settings: updateThreadSchema
                .pick({
                  agentId: true,
                  model: true,
                  reasoningEffort: true,
                })
                .optional(),
            })
            .parse(args);
          if (!Object.values(patch).some((value) => value !== undefined))
            throw new Error('Provide at least one Agent field to update.');
          const previous = await service.getAgent(userId, roomId, memberId);
          if (execution.abortSignal?.aborted) return abortedMessage;
          return service.updateAgent(
            userId,
            roomId,
            memberId,
            groupChatAgentUpdateSchema.parse({
              ...patch,
              settings: patch.settings
                ? { ...previous.settings, ...patch.settings }
                : undefined,
            }),
          );
        },
        true,
      ),
  });
}

export function createGroupChatTools(context: GroupChatAgentContext) {
  const { service, roomId, memberId } = context;
  const run = <T>(
    execution: ToolExecutionContext,
    action: (userId: string) => Promise<T>,
  ) => runInRoom(context, execution, action);

  return {
    send_message: createTool({
      id: 'send_message',
      description:
        'Publish a visible room message, reply or file. For a simple question, put the question in text and add choices: { options: ["Option A", "Option B"], multiple: false }. Single choice sends on click; multiple: true lets the user select several options then send. Returns immediately without waiting for an answer; a human selection becomes a new user message delivered immediately to the bot thread. Returns plain text: Send message success Id: <id>. To delegate, include the exact @mention from get_room_info in text; each mentioned room agent wakes in its own existing thread. Use action send for delegation too. Your final assistant response stays private. Use messageId for replies and the separate reaction tool for reactions. File paths must belong to this room workspace. Images, videos and audio delivered through files are automatically added to the resource gallery.',
      inputSchema: z.object({
        action: z.enum(['send', 'reply', 'file']).default('send'),
        text: z.string().optional(),
        messageId: z.string().optional(),
        choices: z
          .object({
            options: z.array(z.string()),
            multiple: z.boolean().default(false),
          })
          .optional(),
        files: z
          .array(z.object({ path: z.string(), name: z.string() }))
          .optional(),
      }),
      execute: async (input, execution) =>
        run(execution, async (userId) => {
          if (input.action === 'reply' && !input.messageId)
            throw new Error('Provide messageId for the message to reply to.');
          if (input.action === 'file' && !input.files?.length)
            throw new Error('Provide at least one workspace file.');
          if (input.choices && !input.text?.trim())
            throw new Error('Provide the question in text when using choices.');
          if (!input.text?.trim() && !input.files?.length)
            throw new Error('Provide message text or a workspace file.');
          const message = await service.sendAgent(userId, roomId, memberId, {
            id: operationId(context, execution, 'message'),
            ...(execution.agent?.toolCallId
              ? { toolCallId: execution.agent.toolCallId }
              : {}),
            text:
              input.text?.trim() ||
              input.files!.map((file) => file.name).join(', '),
            ...(input.messageId ? { replyToId: input.messageId } : {}),
            ...(input.files ? { files: input.files } : {}),
            ...(input.choices
              ? { choices: groupChatChoicesSchema.parse(input.choices) }
              : {}),
          });
          return `Send message success Id: ${message.id}`;
        }),
    }),
    reaction: createTool({
      id: 'reaction',
      description:
        'Add or remove your own reactions on one or more room messages. Provide a reactions list of messageId, emoji and optional active (true adds, false removes; defaults to true). Different messages can use different emojis; use 👀 for read/received, ✅ for completed and ⭐ for bookmarks. Entries run in order, including repeated message IDs. Returns a plain-text result for each entry; a failed entry does not undo successful entries or prevent later entries. Reactions do not send new messages or wake agents. Aborting stops the remaining entries.',
      inputSchema: z.object({
        reactions: z.array(
          z.object({
            messageId: z.string(),
            emoji: z.string(),
            active: z.boolean().optional(),
          }),
        ),
      }),
      execute: async (input, execution) =>
        run(execution, async (userId) => {
          if (!input.reactions.length)
            throw new Error('Provide at least one reaction.');
          const results: string[] = [];
          for (const { messageId, emoji, active = true } of input.reactions) {
            if (execution.abortSignal?.aborted) return abortedMessage;
            try {
              await service.react(
                userId,
                roomId,
                messageId,
                { emoji, active },
                memberId,
              );
              results.push(
                `OK ${messageId}: ${active ? 'added' : 'removed'} ${emoji}`,
              );
            } catch (error) {
              if (execution.abortSignal?.aborted) return abortedMessage;
              results.push(
                `ERROR ${messageId} (${emoji}): ${error instanceof Error ? error.message : 'Reaction failed'}`,
              );
            }
          }
          return results.join('\n');
        }),
    }),
    get_room_info: createTool({
      id: 'get_room_info',
      description:
        'Read this room, its members, the sole bot leader and execution states. Agents and external A2A members include mention strings for send_message. Mentioning an enabled local agent wakes its thread; external A2A members read the room feed and respond from their own service.',
      inputSchema: z.object({}),
      execute: async (_input, execution) =>
        run(execution, async (userId) => {
          const room = await service.get(userId, roomId);
          const mentionMembers = [
            ...room.agents,
            ...(room.a2aMembers ?? []).filter((member) => !member.revokedAt),
          ];
          return {
            ...room,
            agents: room.agents.map((agent) => ({
              ...agent,
              mention: roomAgentMention(agent, mentionMembers),
            })),
            a2aMembers: (room.a2aMembers ?? []).map((member) => ({
              ...member,
              mention: member.revokedAt
                ? null
                : roomAgentMention(member, mentionMembers),
            })),
          };
        }),
    }),
    get_room_messages: createTool({
      id: 'get_room_messages',
      description:
        'Read recent room messages without changing your unread cursor. Each message includes senderId, senderKind, senderName (display name) and senderUsername when available. Page backward with before using the earliest sequence, or forward with after. Do not provide both.',
      inputSchema: z.object({
        before: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().optional(),
      }),
      execute: async (input, execution) =>
        run(execution, async (userId) => {
          if (input.before && input.after)
            throw new Error('Use either before or after.');
          for (const value of [input.before, input.after])
            if (value !== undefined && !/^(0|[1-9][0-9]{0,18})$/.test(value))
              throw new Error('Use a sequence returned by get_room_messages.');
          const page = await service.messages(userId, roomId, {
            ...input,
            limit: pageSize(input.limit),
          });
          return { ...page, messages: page.messages.map(messageWithoutRoom) };
        }),
    }),
    search_room_messages: createTool({
      id: 'search_room_messages',
      description:
        'Search room messages using BM25, optionally filtering by reactions (match any listed tag). Use reactions: ["⭐"] to find bookmarked messages; omit query to list matching reactions newest first. Each result includes senderName and senderUsername, plus senderId and senderKind. Search does not change unread cursors.',
      inputSchema: z.object({
        query: z.string().optional(),
        reactions: z
          .array(z.string())
          .optional()
          .describe(
            'Reaction tags to match, e.g. ["⭐"] for bookmarks or ["✅", "👀"]. Matches any listed tag, from any room member.',
          ),
        limit: z.number().optional(),
      }),
      execute: async (input, execution) =>
        run(execution, async (userId) => {
          const page = await service.search(userId, roomId, {
            query: input.query,
            reactions: input.reactions,
            limit: pageSize(input.limit),
          });
          return { ...page, messages: page.messages.map(messageWithoutRoom) };
        }),
    }),
    get_room_recent_messages: createTool({
      id: 'get_room_recent_messages',
      description:
        'Read this agent’s unseen room messages and mark only returned messages read. Each message includes senderName and senderUsername when available, alongside senderId and senderKind. Call this on a room event. If hasMore is true, call again until caught up; other agents have independent cursors.',
      inputSchema: z.object({ limit: z.number().optional() }),
      execute: async (input, execution) =>
        run(execution, async (userId) => {
          const page = await service.recentMessages(
            userId,
            roomId,
            memberId,
            pageSize(input.limit),
          );
          return { ...page, messages: page.messages.map(messageWithoutRoom) };
        }),
    }),
    future_plan: createTool({
      id: 'future_plan',
      description:
        'Persist one future action at an absolute ISO date/time with timezone. Return immediately. It fires once in this same agent thread and survives a server restart; it does not create a new chat or keep this run waiting.',
      inputSchema: z.object({
        text: z.string(),
        runAt: z
          .string()
          .describe(
            'ISO timestamp with timezone, for example 2026-11-01T09:00:00+08:00.',
          ),
      }),
      execute: async (input, execution) =>
        run(execution, (userId) =>
          service.createPlan(userId, roomId, memberId, {
            ...input,
            id: operationId(context, execution, 'plan'),
          }),
        ),
    }),
    send_ui: createTool({
      id: 'send_ui',
      description: `Publish a rich HTML panel as a persistent room message and return immediately. This tool NEVER suspends or waits for user input. Use it for reports, charts, cards, diagrams, proposals, selectors and forms. Provide self-contained html, optional title and tips; keep inline CSS/JavaScript, SVG or canvas, responsive natural document height, readable labels and keyboard access. Honor prefers-reduced-motion and use --background, --foreground, --muted, --muted-foreground, --primary, --primary-foreground and --border CSS variables.
If the user should respond, use a user-activated window.IntelligentUI.send({action:'submit', ...values}) or a declarative <form data-ui-send='{"action":"submit"}'> with named fields. Their submission becomes an ordinary room user message, processed in a later turn. Continue your current work or finish; do not wait, poll or call a suspend tool. Accumulate intermediate changes locally, and submit only intentional user actions; do not submit on load. Different members may respond independently.
The panel runs in the existing isolated IntelligentUI sandbox. No host DOM, cookies, storage, network APIs, external scripts/styles/fonts, frames, downloads or automatic navigation. Embed fetched data. HTTP/HTTPS images and user-activated descriptive links are supported. Do not add implementation details to the visible UI.`,
      inputSchema: intelligentUiInputSchema.omit({ waitForResponse: true }),
      execute: async (input, execution) =>
        run(execution, async (userId) => {
          if (!input.html.trim())
            throw new Error('Provide HTML content for the panel.');
          const message = await service.sendAgent(userId, roomId, memberId, {
            id: operationId(context, execution, 'ui'),
            text: input.title?.trim() || input.tips?.trim() || '交互面板',
            ui: input,
          });
          return { messageId: message.id, rendered: true };
        }),
    }),
  };
}
