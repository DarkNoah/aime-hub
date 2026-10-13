import { z } from 'zod';
import { chatSettingsSchema, type ChatSettings } from './threads.js';

export const projectIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{16}$/);
export const projectRoles = ['owner', 'admin', 'member'] as const;
export type ProjectRole = (typeof projectRoles)[number];
const filesystemSchema = z.object({
  provider: z.enum(['local', 'agentfs']),
});
const mountSchema = filesystemSchema
  .extend({
    mountPath: z
      .string()
      .trim()
      .max(64, 'projects.workspace.invalidMount')
      .refine(
        (name) =>
          name.length > 0 &&
          name !== '.' &&
          name !== '..' &&
          !/[\\/]/.test(name) &&
          ![...name].some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
        'projects.workspace.invalidMount',
      ),
  })
  .strict();

export const projectWorkspaceSchema = z
  .discriminatedUnion('mode', [
    filesystemSchema
      .pick({ provider: true })
      .extend({ mode: z.literal('simple') })
      .strict(),
    z
      .object({
        mode: z.literal('composite'),
        mounts: z.array(mountSchema).min(1).max(16),
      })
      .strict(),
  ])
  .superRefine((workspace, context) => {
    if (workspace.mode !== 'composite') return;
    workspace.mounts.forEach((mount, index) => {
      if (
        workspace.mounts
          .slice(0, index)
          .some(
            (other) =>
              mount.mountPath.toLowerCase() === other.mountPath.toLowerCase(),
          )
      )
        context.addIssue({
          code: 'custom',
          path: ['mounts', index, 'mountPath'],
          message: 'projects.workspace.mountConflict',
        });
    });
  });
export type ProjectWorkspace = z.infer<typeof projectWorkspaceSchema>;
export const defaultProjectWorkspace: ProjectWorkspace = {
  mode: 'simple',
  provider: 'local',
};
export const projectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export const gitHubRepositoryUrlSchema = z
  .string()
  .trim()
  .max(300)
  .regex(
    /^(?:https:\/\/github\.com\/)?[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/)?$/i,
    'projects.github.invalidUrl',
  )
  .transform((value) => {
    const repository = value
      .replace(/^https:\/\/github\.com\//i, '')
      .replace(/\/$/, '')
      .replace(/\.git$/i, '');
    return `https://github.com/${repository}.git`;
  });

export const projectGitHubSourceSchema = z
  .object({
    type: z.literal('github'),
    repositoryUrl: gitHubRepositoryUrlSchema,
    branch: z
      .string()
      .trim()
      .max(255, 'projects.github.invalidBranch')
      .refine(
        (value) =>
          !value ||
          (value !== '@' &&
            !value.startsWith('-') &&
            !/[\s~^:?*[\\]/.test(value) &&
            ![...value].some(
              (character) =>
                character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            ) &&
            !value.includes('..') &&
            !value.includes('@{') &&
            value
              .split('/')
              .every(
                (part) =>
                  part &&
                  !part.startsWith('.') &&
                  !part.endsWith('.') &&
                  !part.endsWith('.lock'),
              )),
        'projects.github.invalidBranch',
      )
      .transform((value) => value || undefined)
      .optional(),
  })
  .strict();
export type ProjectGitHubSource = z.infer<typeof projectGitHubSourceSchema>;

export const projectCreateSchema = projectInputSchema
  .extend({
    workspace: projectWorkspaceSchema.default(defaultProjectWorkspace),
    source: projectGitHubSourceSchema.optional(),
  })
  .superRefine((input, context) => {
    if (
      input.source &&
      (input.workspace.mode !== 'simple' ||
        input.workspace.provider !== 'local')
    )
      context.addIssue({
        code: 'custom',
        path: ['workspace'],
        message: 'projects.github.localRequired',
      });
  });
export type ProjectCreateInput = z.input<typeof projectCreateSchema>;
export const projectUpdateSchema = projectInputSchema
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine((input) => input.name !== undefined || input.archived !== undefined);
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ProjectListStatus = 'active' | 'archived' | 'all';
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
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ProjectDetail = ProjectSummary & {
  settings: ChatSettings;
  workspace: ProjectWorkspace;
  source?: ProjectGitHubSource;
};
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
