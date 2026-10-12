import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SkillError } from './errors.js';
import { parseGitHubRepository } from './github.js';

export const SKILL_SOURCES_FILE = '.skill-sources.json';
const sourceSchema = z
  .object({
    url: z.string().min(1),
    ref: z.string().min(1).nullable(),
    scope: z.string(),
  })
  .strict();
export type SkillSource = z.infer<typeof sourceSchema>;
const sourcesSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(sourceSchema).min(1),
  })
  .strict();

export function normalizeSkillSource(source: string, group?: string) {
  const repository = parseGitHubRepository(source);
  if (group && `${repository.owner}/${repository.repo}` !== group)
    throw new SkillError('SKILL_SOURCE_MISMATCH');
  return repository.refPath
    ? `${repository.url}/${repository.kind}/${repository.refPath.split('/').map(encodeURIComponent).join('/')}`
    : repository.url;
}

export async function readSkillSources(
  directory: string,
): Promise<SkillSource[]> {
  const path = join(directory, SKILL_SOURCES_FILE);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink())
    throw new SkillError('SKILL_UNSAFE_PATH', 403);
  const content = await readFile(path, 'utf8');
  try {
    return sourcesSchema.parse(JSON.parse(content)).sources;
  } catch {
    throw new SkillError('SKILL_SOURCE_UNKNOWN', 409);
  }
}

export function serializeSkillSources(sources: SkillSource[]) {
  return JSON.stringify(
    {
      version: 1,
      sources: [
        ...new Map(sources.map((source) => [source.url, source])).values(),
      ],
    },
    null,
    2,
  );
}
