import { z } from 'zod';
import { chatSettingsSchema, type ChatSettings } from './threads.js';
import {
  intelligentUiInputSchema,
  INTELLIGENT_UI_MAX_RESPONSE,
} from './intelligent-ui.js';

export const groupChatCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  projectId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{16}$/)
    .optional(),
});
export const groupChatFileSchema = z.object({
  path: z.string().min(1).max(2048),
  name: z.string().min(1).max(255),
});
export const groupChatMessageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{16,32}$/),
  text: z.string().trim().min(1).max(20_000),
  replyToId: z.string().optional(),
  files: z.array(groupChatFileSchema).max(20).optional(),
});
export const groupChatUiSchema = intelligentUiInputSchema
  .omit({ waitForResponse: true })
  .extend({
    html: z.string().max(500_000),
  });
export const groupChatUiResponseSchema = z.object({
  id: groupChatMessageSchema.shape.id,
  data: z
    .record(z.string(), z.json())
    .refine(
      (value) => JSON.stringify(value).length <= INTELLIGENT_UI_MAX_RESPONSE,
    ),
});
export const groupChatReactionSchema = z.object({
  emoji: z.string().trim().min(1).max(32),
  active: z.boolean(),
});
export const groupChatAgentCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  settings: chatSettingsSchema,
  enabled: z.boolean().optional(),
});
export const groupChatAgentUpdateSchema = groupChatAgentCreateSchema
  .partial()
  .extend({
    idleWakeHours: z.number().positive().max(8760).nullable().optional(),
  });
export type GroupChatAgentInput = z.infer<typeof groupChatAgentCreateSchema>;
export type GroupChatAgentUpdate = z.infer<typeof groupChatAgentUpdateSchema>;
export const groupChatA2aMemberCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export const groupChatA2aMemberUpdateSchema = groupChatA2aMemberCreateSchema
  .partial()
  .extend({ enabled: z.boolean().optional() });
export type GroupChatA2AMember = {
  id: string;
  roomId: string;
  name: string;
  enabled: boolean;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
export type GroupChatUi = z.infer<typeof groupChatUiSchema>;
export type GroupChatFile = z.infer<typeof groupChatFileSchema>;
export type GroupChat = {
  id: string;
  title: string;
  projectId: string | null;
  createdBy: string;
  ownerName?: string;
  createdAt: string;
  updatedAt: string;
};
export type GroupChatAgent = {
  id: string;
  roomId: string;
  threadId: string;
  name: string;
  role: 'bot' | 'worker';
  settings: ChatSettings;
  enabled: boolean;
  status: 'idle' | 'running' | 'failed';
  error: string | null;
  lastReadSequence: string;
  /** Bot-only inactivity interval; null disables proactive idle wake-ups. */
  idleWakeHours: number | null;
};
export type GroupChatDetail = GroupChat & {
  memberIds: string[];
  canManage: boolean;
  canManageMembers?: boolean;
  agents: GroupChatAgent[];
  a2aMembers?: GroupChatA2AMember[];
  botAgentId: string;
};

type MentionAgent = Pick<GroupChatAgent, 'id' | 'name'>;

/** Names are readable; duplicate or multiline names use the stable room member ID. */
export function roomAgentMention(
  agent: MentionAgent,
  agents: readonly MentionAgent[],
) {
  const name = agent.name.trim();
  return `@${name && !/[\r\n@]/.test(name) && agents.filter((item) => item.name.trim() === name).length === 1 ? name : agent.id}`;
}

/** Exact room-local mentions. Longest names win; email addresses and code are not mentions. */
export function mentionedRoomAgentIds(
  text: string,
  agents: readonly MentionAgent[],
) {
  const candidates = agents
    .flatMap((agent) =>
      [...new Set([roomAgentMention(agent, agents), `@${agent.id}`])].map(
        (mention) => ({ id: agent.id, mention }),
      ),
    )
    .sort((left, right) => right.mention.length - left.mention.length);
  const content = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ');
  const found = new Set<string>();
  for (const match of content.matchAll(/(?:^|[\s([{"'“‘，。！？、：；])@/gu)) {
    const offset = match.index + match[0].length - 1;
    const candidate = candidates.find(
      ({ mention }) =>
        content.startsWith(mention, offset) &&
        !/[\p{L}\p{N}_-]/u.test(content[offset + mention.length] ?? ''),
    );
    if (candidate) found.add(candidate.id);
  }
  return [...found];
}
export type GroupChatList = { rooms: GroupChat[]; hasMore: boolean };
export const groupChatSequenceSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const groupChatReadSchema = z.object({
  sequence: groupChatSequenceSchema,
});
export type GroupChatReadState = {
  roomId: string;
  projectId: string | null;
  /** Latest message from someone other than the current user; reactions do not advance it. */
  latestSequence: string;
  readSequence: string;
};
export type GroupChatMessage = {
  id: string;
  roomId: string;
  sequence: string;
  revision: string;
  senderId: string;
  senderKind: 'user' | 'agent' | 'a2a';
  /** Public sender identity, resolved by the server for human and Agent messages. */
  senderName: string | null;
  senderUsername: string | null;
  text: string;
  replyToId: string | null;
  files: GroupChatFile[];
  ui: GroupChatUi | null;
  uiResponse: {
    sourceMessageId: string;
    data: z.infer<typeof groupChatUiResponseSchema>['data'];
  } | null;
  targetAgentId: string | null;
  reactions: { emoji: string; memberIds: string[] }[];
  createdAt: string;
};
export type GroupChatMessages = {
  messages: GroupChatMessage[];
  hasMore: boolean;
  /** Changes cursor independent of history order; captures edits/reactions. */
  revision: string;
};
export type GroupChatSearch = {
  messages: (GroupChatMessage & { score: number })[];
  hasMore: boolean;
};
export type GroupChatEvent = {
  id: string;
  version: string;
  roomId: string;
  agentId: string;
  actorId: string;
  kind: 'messages' | 'task' | 'plan' | 'idle';
  text: string;
  dueAt: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
};
/** Public member fields only; never expose email or authentication metadata. */
export type MemberProfile = {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
};
