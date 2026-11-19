import { relative, resolve, sep } from 'node:path';
import type { ChatSkill } from '@aime/shared/threads';
import type { RuntimeAgent } from '@aime/shared/agents';
import { AgentError } from '../agents/errors.js';
import {
  discoverInstalledSkills,
  discoverPersonalSkills,
  discoverProjectSkills,
  projectDirectory,
  type DiscoveredSkill,
} from './workspace.js';
import { SkillOrigins } from '../skills/origins.js';
import type { SkillDestination } from '@aime/shared/skills';
import { directorySkillConfig, ScopedSkillsWorkspace } from './skill-source.js';

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

async function chatSkillOrigins(
  root: string,
  discovered: DiscoveredSkill[],
  projectId?: string,
) {
  const global = resolve(root, '.agents', 'skills');
  const origins = new SkillOrigins(global);
  const names = new Map<string, string>();
  async function collect(target: SkillDestination, directory: string) {
    const packages = discovered
      .filter((skill) => !skill.sourceUserId)
      .map((skill) => skill.packageRoot ?? skill.path)
      .filter((path) => path.startsWith(directory + sep))
      .map((path) => relative(directory, path));
    const found = await origins.find(target, directory, packages);
    for (const [path, sharing] of found)
      names.set(resolve(directory, path), sharing.userName);
  }
  await Promise.all([
    collect({ scope: 'global' }, global),
    projectId &&
      collect(
        { scope: 'project', projectId },
        resolve(projectDirectory(root, projectId), '.agents', 'skills'),
      ),
  ]);
  return names;
}

export async function listChatSkills(
  root: string,
  userId: string,
  projectId?: string,
  resolveUserNames?: (ids: string[]) => Promise<ReadonlyMap<string, string>>,
): Promise<ChatSkill[]> {
  const discovered = await (projectId
    ? discoverProjectSkills(root, projectId, userId)
    : discoverPersonalSkills(root, userId));
  if (!discovered.length) return [];
  // The catalog and the Agent share directory-based identities and validation.
  const workspace = new ScopedSkillsWorkspace(
    directorySkillConfig(
      discovered.map((skill) => skill.path),
      userId,
      root,
      projectId,
    ),
    userId,
  );
  const installations = new Map(
    discovered.map((skill) => [resolve(skill.path), skill]),
  );
  try {
    const publishers = [
      ...new Set(
        discovered.flatMap((skill) =>
          skill.sourceUserId ? [skill.sourceUserId] : [],
        ),
      ),
    ];
    const [skills, origins, userNames] = await Promise.all([
      workspace.skills?.list() ?? [],
      chatSkillOrigins(root, discovered, projectId),
      publishers.length ? resolveUserNames?.(publishers) : undefined,
    ]);
    return skills
      .filter((skill) => skill['user-invocable'] !== false)
      .map(({ name, description, path }) => {
        const installed = installations.get(resolve(path));
        const sourceUserName = installed?.sourceUserId
          ? (userNames?.get(installed.sourceUserId) ?? installed.sourceUserId)
          : origins.get(installed?.packageRoot ?? resolve(path));
        return {
          name,
          description,
          group: installed?.group.split(sep).join('/') ?? '',
          ...(sourceUserName && { sourceUserName }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await workspace.destroy();
  }
}
