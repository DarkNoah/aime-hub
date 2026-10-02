import { z } from 'zod';
import { chatSettingsSchema, type ChatSettings } from './threads.js';

export const projectIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{16}$/);
export const projectRoles = ['owner', 'admin', 'member'] as const;
export type ProjectRole = (typeof projectRoles)[number];
export const projectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export const projectMemberSchema = z
  .object({
    userId: z.string().min(1).max(128),
    role: z.enum(['admin', 'member']).default('member'),
  })
  .strict();
export const projectMemberRoleSchema = projectMemberSchema.pick({ role: true });
export const projectPreferencesSchema = chatSettingsSchema;
export type ProjectSummary = {
  id: string;
  name: string;
  createdBy: string;
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
};
export type ProjectDetail = ProjectSummary & { settings: ChatSettings };
export type ProjectList = {
  projects: ProjectSummary[];
  page: number;
  hasMore: boolean;
};
export type ProjectUser = { id: string; name: string; username: string | null };
export type ProjectMember = ProjectUser & {
  role: ProjectRole;
  createdAt: string;
};
