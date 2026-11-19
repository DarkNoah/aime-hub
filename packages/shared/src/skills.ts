import { z } from 'zod';
import { projectIdSchema } from './projects.js';

export const SKILL_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
export const SKILL_ARCHIVE_MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
export const SKILL_ARCHIVE_MAX_ENTRIES = 10_000;

export const scanSkillsSchema = z
  .object({
    url: z.string().trim().min(1),
    mode: z.enum(['skills', 'project']).default('skills'),
  })
  .strict();
export const installSkillsSchema = z
  .object({
    scanId: z.string().uuid(),
    paths: z.array(z.string().min(1)).min(1),
  })
  .strict();
export const removeSkillSchema = z.object({ path: z.string().min(1) }).strict();
export const readSkillSchema = z.object({ path: z.string() }).strict();
export const removeSkillGroupSchema = z
  .object({
    group: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const updateSkillGroupSchema = z
  .object({
    group: z.string().min(1),
    source: z.string().trim().min(1).optional(),
  })
  .strict();

export const skillDestinationSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }).strict(),
  z
    .object({ scope: z.literal('project'), projectId: projectIdSchema })
    .strict(),
]);
export type SkillDestination = z.infer<typeof skillDestinationSchema>;

export const sharePersonalSkillSchema = z
  .object({
    path: z.string().min(1),
    target: z.union([
      skillDestinationSchema,
      z
        .object({ scope: z.literal('personal'), from: skillDestinationSchema })
        .strict(),
    ]),
  })
  .strict();

export type SkillSharing = SkillDestination & {
  userId: string;
  userName: string;
  projectName?: string;
  /** Previously moved physical installation. Withdraw to restore its personal copy. */
  legacyMoved?: true;
};

export type SkillSharingOptions = {
  global: boolean;
  projects: { id: string; name: string }[];
  shared: InstalledSkill[];
};

export type InstalledSkill = {
  sharing?: SkillSharing;
  sourceType?: 'github' | 'archive';
  projectRoot?: string;
  path: string;
  name: string;
  description: string;
  group: string;
  valid: boolean;
};

export type RepositorySkill = {
  /** Repository-relative SKILL.md path; the selection identity. */
  path: string;
  group: string;
  name: string;
  description: string;
  destination: string;
  installed: boolean;
  valid: boolean;
  errors: string[];
  fileCount: number;
  bytes: number;
  skippedFiles: number;
  /** Descendant manifests included as resources, never separate install targets. */
  bundledSkills?: string[];
  package?: boolean;
};

export type SkillScan = {
  importMode?: 'skills' | 'project';
  project?: {
    destination: string;
    fileCount: number;
    bytes: number;
    skippedFiles: number;
  };
  sourceType?: 'github' | 'archive';
  filename?: string;
  id: string;
  owner: string;
  repo: string;
  url: string;
  commit: string;
  scope: string;
  ref: string | null;
  expiresAt: string;
  skills: RepositorySkill[];
};

export type InstalledSkills = { root: string; skills: InstalledSkill[] };
export type SkillContent = { skill: InstalledSkill; content: string };

export function skillGroupRepositoryUrl(group: string) {
  return /^[a-zA-Z0-9-]+\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(group)
    ? `https://github.com/${group}`
    : null;
}
