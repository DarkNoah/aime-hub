import { Workspace } from '@mastra/core/workspace';
import { resolve, sep } from 'node:path';
import type { ChatSkill } from '@aime/shared/threads';
import { discoverPersonalSkills, discoverProjectSkills } from './workspace.js';
import { directorySkillConfig } from './skill-source.js';

export async function listChatSkills(
  root: string,
  userId: string,
  projectId?: string,
): Promise<ChatSkill[]> {
  const discovered = await (projectId
    ? discoverProjectSkills(root, projectId)
    : discoverPersonalSkills(root, userId));
  // The catalog and the Agent share directory-based identities and validation.
  const workspace = new Workspace(
    directorySkillConfig(discovered.map((skill) => skill.path)),
  );
  const groups = new Map(
    discovered.map((skill) => [
      resolve(skill.path),
      skill.group.split(sep).join('/'),
    ]),
  );
  try {
    const skills = (await workspace.skills?.list()) ?? [];
    return skills
      .filter((skill) => skill['user-invocable'] !== false)
      .map(({ name, description, path }) => ({
        name,
        description,
        group: groups.get(resolve(path)) ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await workspace.destroy();
  }
}
