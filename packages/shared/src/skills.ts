import { z } from 'zod';

export const scanSkillsSchema = z
  .object({ url: z.string().trim().min(1) })
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

export type InstalledSkill = {
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
