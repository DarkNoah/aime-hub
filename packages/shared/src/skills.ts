import { z } from 'zod';

export const scanSkillsSchema = z
  .object({ url: z.string().trim().min(1).max(2048) })
  .strict();
export const installSkillsSchema = z
  .object({
    scanId: z.string().uuid(),
    paths: z.array(z.string().min(1).max(2048)).min(1).max(500),
  })
  .strict();
export const removeSkillSchema = z
  .object({ path: z.string().min(1).max(2048) })
  .strict();
export const removeSkillGroupSchema = z
  .object({
    group: z.string().min(1).max(2048),
    paths: z.array(z.string().min(1).max(2048)).min(1).max(500),
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
