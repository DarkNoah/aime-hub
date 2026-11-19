import type { InstalledSkill } from '@aime/shared/skills';
import { listFiles } from '../files/service.js';
import { SkillError } from './errors.js';
import { SKILL_META_DIRECTORY } from './project.js';

function hasManagedMetadata(skill: InstalledSkill) {
  return skill.path === skill.projectRoot && skill.projectRoot === skill.group;
}

export function assertSkillFilePath(skill: InstalledSkill, path: string) {
  if (
    path.split('/').some(isOriginMarker) ||
    (hasManagedMetadata(skill) &&
      path.split('/')[0].toLowerCase() === SKILL_META_DIRECTORY)
  )
    throw new SkillError('SKILL_UNSAFE_PATH', 403);
}

function isOriginMarker(name: string) {
  return /^\.skill-origin-[a-f\d]{64}$/i.test(name);
}

export async function listSkillFiles(
  root: string,
  skill: InstalledSkill,
  path: string,
) {
  assertSkillFilePath(skill, path);
  const listing = await listFiles(root, path);
  listing.entries = listing.entries.filter(
    (entry) =>
      !isOriginMarker(entry.name) &&
      (path ||
        !hasManagedMetadata(skill) ||
        entry.name.toLowerCase() !== SKILL_META_DIRECTORY),
  );
  return listing;
}
