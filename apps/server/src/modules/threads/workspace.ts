import { mkdir, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, basename, dirname, isAbsolute } from 'node:path';
import { nanoid } from 'nanoid';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { ThreadError } from './errors.js';

export function userDirectory(root: string, userId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new ThreadError('INVALID_USER');
  return resolve(root, 'users', userId);
}

export async function createPersonalWorkspace(root: string, userId: string) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const path = resolve(userDirectory(root, userId), `${date}-${nanoid(6)}`);
  await mkdir(path, { recursive: true });
  return path;
}

export function getWorkspace(root: string, userId: string, path: string) {
  const owner = userDirectory(root, userId);
  if (dirname(path) !== owner)
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 500);
  return new Workspace({
    id: basename(path),
    filesystem: new LocalFilesystem({ basePath: path, contained: true }),
  });
}

export type DiscoveredSkill = { id: string; group: string; path: string };
async function discover(root: string): Promise<DiscoveredSkill[]> {
  const result: DiscoveredSkill[] = [];
  const canonicalRoot = await realpath(root).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (!canonicalRoot) return result;
  const rootPath: string = canonicalRoot;
  async function visit(directory: string, depth: number) {
    if (depth > 12 || result.length >= 500) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      const actual = await realpath(directory);
      const path = relative(rootPath, actual);
      if (path.startsWith('..') || isAbsolute(path)) return;
      result.push({
        id: basename(directory),
        group: dirname(relative(root, directory)).replace(/^\.$/, ''),
        path: directory,
      });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.'))
        await visit(resolve(directory, entry.name), depth + 1);
    }
  }
  await visit(resolve(root), 0);
  return result;
}

export async function discoverPersonalSkills(root: string, userId: string) {
  const [global, personal] = await Promise.all([
    discover(resolve(root, '.skills')),
    discover(resolve(userDirectory(root, userId), '.skills')),
  ]);
  return [
    ...new Map(
      [...global, ...personal].map((skill) => [skill.id, skill]),
    ).values(),
  ];
}
