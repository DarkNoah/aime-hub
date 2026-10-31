import { z } from 'zod';
import { chatSettingsSchema } from './threads.js';

export const issueStates = ['decision', 'todo', 'in_progress', 'done'] as const;
export const issueStateSchema = z.enum(issueStates);
export type IssueState = z.infer<typeof issueStateSchema>;
export const issueScopeSchema = z.object({ projectId: z.string().optional() });
export type IssueScope = z.infer<typeof issueScopeSchema>;
export const issueCreateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().max(50000).default(''),
  state: issueStateSchema.default('todo'),
  settings: chatSettingsSchema.optional(),
});
export const issuePatchSchema = z.object({
  title: issueCreateSchema.shape.title.optional(),
  // Creation defaults must not be applied to omitted fields in a partial update.
  body: issueCreateSchema.shape.body.removeDefault().optional(),
  state: issueStateSchema.optional(),
});
export type IssueCreate = z.infer<typeof issueCreateSchema>;
export type IssuePatch = z.infer<typeof issuePatchSchema>;
export const issueListSchema = issueScopeSchema.extend({
  state: z.enum([...issueStates, 'open', 'all']).default('all'),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export type IssueListInput = z.infer<typeof issueListSchema>;
export type Issue = {
  id: number;
  title: string;
  body: string;
  state: IssueState;
  projectId: string | null;
  createdBy: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};
export type IssueComment = {
  id: string;
  issueId: number;
  authorId: string;
  authorName: string | null;
  body: string;
  kind: 'comment' | 'message';
  delivery: 'wait' | 'immediate' | null;
  createdAt: string;
};
export type IssueList = {
  items: Issue[];
  counts: Record<IssueState, number>;
  nextCursor: number | null;
};
export type IssueDetail = {
  issue: Issue;
  comments: IssueComment[];
  nextCursor: string | null;
};
export const issueCommentSchema = z.object({
  body: z.string().trim().min(1).max(50000),
});
export const issueMessageSchema = issueCommentSchema.extend({
  delivery: z.enum(['wait', 'immediate']).default('wait'),
});
