import { z } from 'zod';
import type { ProjectSummary } from './projects.js';

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
    model: z.string().min(3).max(512).nullable().default(null),
    reasoningEffort: reasoningEffortSchema.default('auto'),
  })
  .strict();
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export const createThreadSchema = chatSettingsSchema.extend({
  title: z.string().trim().min(1).max(120).optional(),
  projectId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{16}$/)
    .optional(),
});
export const updateThreadSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
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
    createdBy: z.string().trim().optional(),
    createdAt: z.string().trim().optional(),
  })
  .strict();
export type RunInput = z.infer<typeof runInputSchema>;
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
  id: string;
  text: string;
  isImmediate: boolean;
  createdAt: string;
};
export type ThreadStatus = 'idle' | 'running' | 'stopping' | 'error';
export type ThreadSummary = ChatSettings & {
  id: string;
  projectId?: string | null;
  createdBy?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: ThreadStatus;
  queue: QueuedMessage[];
  error: string | null;
};
export type ThreadSnapshot<Message> = {
  thread: ThreadSummary;
  messages: Message[];
  activeMessageId: string | null;
  usage?: ChatUsage | null;
};
// Usage from the latest completed LLM step, not a sum across context windows.
export type ChatUsage = {
  model: string;
  maxTokens: number | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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
  | { type: 'snapshot'; threads: ThreadSummary[]; projects: ProjectSummary[] }
  | { type: 'upsert'; thread: ThreadSummary }
  | { type: 'remove'; id: string; projectId: string | null }
  | { type: 'project-removed'; projectId: string };
export type MessagePage<Message> = {
  messages: Message[];
  hasMore: boolean;
  page: number;
  anchor: string;
};
