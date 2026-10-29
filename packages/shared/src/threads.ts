import { z } from 'zod';
import type { ProjectSummary } from './projects.js';
import { agentIdSchema } from './agents.js';

export const thinkingLevels = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const reasoningEfforts = ['auto', ...thinkingLevels] as const;
export const reasoningEffortSchema = z.enum(reasoningEfforts);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const chatSettingsSchema = z
  .object({
    agentId: agentIdSchema.nullable().optional(),
    model: z.string().min(3).max(512).nullable().default(null),
    reasoningEffort: reasoningEffortSchema.default('auto'),
  })
  .strict();
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export type ChatSkill = {
  /** Canonical skill ID and command name, taken from the package directory. */
  name: string;
  description: string;
  /** Parent directory relative to the skills root, e.g. owner/repo. */
  group: string;
};
export const createThreadSchema = chatSettingsSchema.extend({
  title: z.string().trim().min(1).max(120).optional(),
  /** ID of the plugin that created this thread. */
  plugin: z.string().trim().min(1).optional(),
  /** Use the plugin's persistent workspace when the enabled plugin declares one. */
  usePluginWorkspace: z.boolean().optional(),
  projectId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{16}$/)
    .optional(),
});
export type CreateThreadInput = z.infer<typeof createThreadSchema>;
export const updateThreadSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    agentId: chatSettingsSchema.shape.agentId,
    model: chatSettingsSchema.shape.model.removeDefault().optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .strict();
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_CHAT_FILES = 4;
export const chatPartSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      text: z.string().trim().min(1).max(60000),
    })
    .strict(),
  z
    .object({
      type: z.literal('file'),
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      filename: z.string().max(255).optional(),
      url: z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100),
    })
    .strict()
    .refine((part) => {
      const prefix = `data:${part.mediaType};base64,`;
      return (
        part.url.startsWith(prefix) &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(part.url.slice(prefix.length))
      );
    }),
]);
export const runInputSchema = chatSettingsSchema
  .extend({
    id: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
    parts: z
      .array(chatPartSchema)
      .min(1)
      .max(8)
      .refine(
        (parts) =>
          parts.filter((part) => part.type === 'file').length <= MAX_CHAT_FILES,
      ),
    isImmediate: z.boolean().default(false),
    /** Start a new durable objective from this message's text. */
    goal: z.boolean().optional(),
    createdBy: z.string().trim().optional(),
    createdAt: z.string().trim().optional(),
  })
  .strict()
  .refine(
    (input) => !input.goal || input.parts.some((part) => part.type === 'text'),
    { message: 'A goal requires a text objective', path: ['parts'] },
  );
export type RunInput = z.infer<typeof runInputSchema>;
export const userQuestionSchema = z.object({
  question: z.string().trim().min(1),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        description: z.string().optional(),
      }),
    )
    .optional(),
  selectionMode: z.enum(['single_select', 'multi_select']).optional(),
});
export type UserQuestion = z.infer<typeof userQuestionSchema>;
export const toolResponseSchema = z.intersection(
  z.object({ id: runInputSchema.shape.id }),
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('resume'), data: z.json() }),
    z.object({ action: z.literal('approve') }),
    z.object({
      action: z.literal('decline'),
      reason: z.string().trim().max(2000).optional(),
    }),
  ]),
);
export type ToolResponse = z.infer<typeof toolResponseSchema>;
export const toolInteractionSchema = z.object({
  kind: z.enum(['approval', 'suspended']),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown().optional(),
  suspendPayload: z.unknown().optional(),
  resumeSchema: z.unknown().optional(),
});
export type ToolInteraction = z.infer<typeof toolInteractionSchema> & {
  id: string;
  response?: ToolResponse;
};
export const updateQueuedMessageSchema = z
  .object({
    text: z.string().trim().max(60000).optional(),
    isImmediate: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => input.text !== undefined || input.isImmediate !== undefined,
  );
export type UpdateQueuedMessage = z.infer<typeof updateQueuedMessageSchema>;
export const moveQueuedMessageSchema = z
  .object({
    id: runInputSchema.shape.id,
    beforeId: runInputSchema.shape.id.nullable(),
  })
  .strict();
export type QueuedMessageDetail = {
  id: string;
  text: string;
  isImmediate: boolean;
  hasAttachments: boolean;
};
export type QueuedMessage = {
  /** A failed resubmission remains an editable draft; it never runs automatically. */
  failed?: boolean;
  id: string;
  text: string;
  isImmediate: boolean;
  createdAt: string;
};
// Matches Mastra's stream.status; idle is only for a thread with no run yet.
export const threadStreamStatusSchema = z.enum([
  'running',
  'success',
  'failed',
  'tripwire',
  'suspended',
  'waiting',
  'pending',
  'canceled',
  'bailed',
  'paused',
  'skipped',
]);
export type ThreadStreamStatus = z.infer<typeof threadStreamStatusSchema>;
export type ThreadStatus = 'idle' | ThreadStreamStatus;
export const isThreadActive = (status?: ThreadStatus) =>
  status === 'running' || status === 'pending';
export type ThreadSummary = ChatSettings & {
  id: string;
  projectId?: string | null;
  /** ID of the plugin that created this thread, when provided. */
  plugin?: string;
  createdBy?: string;
  title: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  status: ThreadStatus;
  queueCount: number;
  /** Presentation copies of native pending inputs, never an execution queue. */
  queue?: QueuedMessage[];
  error: string | null;
};
export type ThreadSnapshot<Message> = {
  thread: ThreadSummary;
  messages: Message[];
  removedMessageIds?: string[];
  activeMessageId: string | null;
  usage?: ChatUsage | null;
  goal?: ThreadGoal | null;
  toolInteractions?: ToolInteraction[];
  backgroundTasks?: ThreadBackgroundTask[];
  backgroundTasksError?: 'BACKGROUND_TASKS_UNAVAILABLE' | null;
  commandSessions?: ThreadCommandSession[];
};
/** Live command handles owned by this thread's Workspace, not persisted jobs. */
export type ThreadCommandSession = {
  sessionId: number;
  cmd: string;
  workdir: string;
  tty: boolean;
  pid?: string;
  status: 'starting' | 'running' | 'stopping' | 'exited';
  createdAt: string;
  exitCode?: number;
};
/** Public projection of Mastra's durable thread objective. */
export type ThreadGoal = {
  id?: string;
  objective: string;
  status: 'active' | 'paused' | 'done';
  runsUsed: number;
  maxRuns: number;
  activeDurationMs: number;
  pausedReason?: string;
  evaluating?: boolean;
  waitingForUser?: boolean;
};
// Thread-scoped view of Mastra's persisted tasks. Dates are serialized for SSE.
export type ThreadBackgroundTask = {
  id: string;
  status:
    | 'pending'
    | 'running'
    | 'suspended'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'timed_out';
  toolName: string;
  toolCallId: string;
  agentId: string;
  runId: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
  createdAt: string;
  startedAt?: string;
  suspendedAt?: string;
  completedAt?: string;
  suspendPayload?: unknown;
  // Only the latest output chunk is retained; this is not an unbounded event log.
  lastOutput?: unknown;
};
// Context counts describe the latest completed LLM step.
export type ChatUsage = {
  model: string;
  maxTokens: number | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  // Sum of reported usage records for this conversation, across steps and models.
  consumedTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};
export type ThreadList = {
  threads: ThreadSummary[];
  hasMore: boolean;
  page: number;
};
// Navigation carries summaries only; message streams remain scoped to the open chat.
export type ThreadNavigationEvent =
  | {
      type: 'snapshot';
      threads: ThreadSummary[];
      projects: ProjectSummary[];
      archivedThreads?: ThreadSummary[];
    }
  | { type: 'upsert'; thread: ThreadSummary }
  | {
      type: 'remove';
      id: string;
      projectId: string | null;
      archivedThread?: ThreadSummary;
    }
  | { type: 'project-removed'; projectId: string };
export type MessagePage<Message> = {
  messages: Message[];
  hasMore: boolean;
  page: number;
  anchor: string;
};
