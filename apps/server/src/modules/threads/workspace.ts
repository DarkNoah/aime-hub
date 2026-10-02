import { mkdir, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, basename, dirname, isAbsolute } from 'node:path';
import { nanoid } from 'nanoid';
import {
  LocalFilesystem,
  Workspace,
  WORKSPACE_TOOLS,
} from '@mastra/core/workspace';
import { ThreadError } from './errors.js';

export function userDirectory(root: string, userId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new ThreadError('INVALID_USER');
  return resolve(root, 'users', userId);
}

export function projectDirectory(root: string, projectId: string) {
  if (!/^[a-zA-Z0-9_-]{16}$/.test(projectId))
    throw new ThreadError('PROJECT_NOT_FOUND', 404);
  return resolve(root, 'projects', projectId);
}

export async function createProjectWorkspace(root: string, projectId: string) {
  const path = projectDirectory(root, projectId);
  await mkdir(path, { recursive: true });
  return path;
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

export function getWorkspace(
  root: string,
  userId: string,
  path: string,
  projectId?: string,
) {
  const valid = projectId
    ? path === projectDirectory(root, projectId)
    : dirname(path) === userDirectory(root, userId);
  if (!valid) throw new ThreadError('WORKSPACE_UNAVAILABLE', 500);
  return new Workspace({
    id: basename(path),
    filesystem: new LocalFilesystem({ basePath: path, contained: true }),
    bm25: true,
    tools: {
      [WORKSPACE_TOOLS.SEARCH.INDEX]: {
        // enabled: false,
        name: 'index',
      },
      [WORKSPACE_TOOLS.SEARCH.SEARCH]: {
        // enabled: false,
        name: 'search',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
        // enabled: false,
        name: 'write_file',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
        // enabled: false,
        name: 'read_file',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
        // enabled: false,
        name: 'edit_file',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
        // enabled: false,
        name: 'grep',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
        enabled: false,
        name: 'list_files',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: {
        enabled: false,
        name: 'file_stat',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: {
        enabled: false,
        name: 'mkdir',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
        enabled: false,
        name: 'delete',
      },
    },
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
    discover(resolve(root, '.agents', 'skills')),
    discover(resolve(userDirectory(root, userId), '.agents', 'skills')),
  ]);
  return [
    ...new Map(
      [...global, ...personal].map((skill) => [skill.id, skill]),
    ).values(),
  ];
}

export async function discoverProjectSkills(root: string, projectId: string) {
  const [global, project] = await Promise.all([
    discover(resolve(root, '.agents', 'skills')),
    discover(resolve(projectDirectory(root, projectId), '.agents', 'skills')),
  ]);
  return [
    ...new Map(
      [...global, ...project].map((skill) => [skill.id, skill]),
    ).values(),
  ];
}
