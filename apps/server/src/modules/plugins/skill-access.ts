import { resolve, relative, sep } from 'node:path';

const sources = new Map<string, (userId?: string) => Promise<Set<string>>>();
export function registerPluginSkillAccess(
  workspaceRoot: string,
  enabled: (userId?: string) => Promise<Set<string>>,
) {
  const root = resolve(workspaceRoot, '.agents', 'skills');
  sources.set(root, enabled);
  return () => {
    sources.delete(root);
  };
}
export async function enabledPluginSkills(
  workspaceRoot: string,
  userId?: string,
) {
  return (
    sources.get(resolve(workspaceRoot, '.agents', 'skills'))?.(userId) ??
    new Set<string>()
  );
}
export async function assertPluginSkillReadable(path: string, userId?: string) {
  for (const [root, enabled] of sources) {
    const parts = relative(root, resolve(path)).split(sep);
    if (
      parts[0] === 'plugins' &&
      parts[1] &&
      !(await enabled(userId)).has(parts[1])
    )
      throw new Error('PLUGIN_DISABLED');
  }
}
