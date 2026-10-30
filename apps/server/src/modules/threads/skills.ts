import { Workspace } from '@mastra/core/workspace';
import { resolve, sep } from 'node:path';
import type { ChatSkill } from '@aime/shared/threads';
import type { RuntimeAgent } from '@aime/shared/agents';
import { AgentError } from '../agents/errors.js';
import {
  discoverInstalledSkills,
  discoverPersonalSkills,
  discoverProjectSkills,
} from './workspace.js';
import { directorySkillConfig } from './skill-source.js';

/** Resolve only server-owned roots for the already-authorized conversation scope. */
export async function resolveAgentSkillPaths(
  root: string,
  userId: string,
  agent: Pick<RuntimeAgent, 'source' | 'skillsMode' | 'skillPaths'>,
  projectId?: string,
): Promise<string[]> {
  if (agent.source === 'code' || agent.skillsMode === 'auto') {
    const skills = await (projectId
      ? discoverProjectSkills(root, projectId, userId)
      : discoverPersonalSkills(root, userId));
    return skills.map((skill) => skill.path);
  }
  if (!agent.skillPaths.length) return [];
  // Custom selections pin exact global installation paths, including when a
  // personal/project skill has the same name. Never add an unselected override.
  const installed = new Set(
    (await discoverInstalledSkills(root, userId)).map((skill) => skill.path),
  );
  return agent.skillPaths.map((path) => {
    const directory = resolve(root, '.agents', 'skills', path);
    if (!installed.has(directory))
      throw new AgentError('AGENT_SKILL_UNAVAILABLE');
    return directory;
  });
}

export async function listChatSkills(
  root: string,
  userId: string,
  projectId?: string,
): Promise<ChatSkill[]> {
  const discovered = await (projectId
    ? discoverProjectSkills(root, projectId, userId)
    : discoverPersonalSkills(root, userId));
  if (!discovered.length) return [];
  // The catalog and the Agent share directory-based identities and validation.
  const workspace = new Workspace(
    directorySkillConfig(
      discovered.map((skill) => skill.path),
      userId,
    ),
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
