import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SkillError } from './errors.js';
import { safeRepositoryPath } from './github.js';

export const SKILL_PROJECT_FILE = '.skill-project.json';
export const skillProjectEntrySchema = z
  .object({
    path: z
      .string()
      .refine(
        (path) => safeRepositoryPath(path) && /(^|\/)SKILL\.md$/.test(path),
      ),
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();
export const skillProjectEntriesSchema = z
  .array(skillProjectEntrySchema)
  .min(1)
  .refine((entries) => {
    const names = new Set(entries.map((entry) => entry.name));
    const paths = new Set(entries.map((entry) => entry.path));
    if (names.size !== entries.length || paths.size !== entries.length)
      return false;
    return entries.every(
      (entry) =>
        !entries.some(
          (other) =>
            other !== entry &&
            (other.path === 'SKILL.md' ||
              entry.path.startsWith(other.path.slice(0, -'SKILL.md'.length))),
        ),
    );
  });
export const skillProjectSchema = z
  .object({
    version: z.literal(1),
    root: z.literal('project'),
    entries: skillProjectEntriesSchema,
  })
  .strict();
export type SkillProject = z.infer<typeof skillProjectSchema>;

/** Read only application-owned group metadata; callers must restrict this to owner/repo groups. */
export async function readSkillProject(
  directory: string,
): Promise<SkillProject | undefined> {
  const marker = join(directory, SKILL_PROJECT_FILE);
  const info = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  try {
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Invalid marker');
    const group = await lstat(directory);
    if (!group.isDirectory() || group.isSymbolicLink())
      throw new Error('Invalid group');
    const project = skillProjectSchema.parse(
      JSON.parse(await readFile(marker, 'utf8')),
    );
    for (const entry of project.entries) {
      let path = directory;
      const parts = [project.root, ...entry.path.split('/')];
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const info = await lstat(path);
        if (
          info.isSymbolicLink() ||
          (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
        )
          throw new Error('Invalid project entry');
      }
    }
    return project;
  } catch {
    throw new SkillError('SKILL_PROJECT_INVALID', 409);
  }
}
