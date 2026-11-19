import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectIdSchema } from '@aime/shared/projects';
import { SkillError } from './errors.js';
import { pruneEmptySkillParents } from './transfer.js';
import { safeRepositoryPath } from './github.js';
import {
  readSkillProject,
  SKILL_META_DIRECTORY,
  SKILL_PROJECT_FILE,
  type SkillProject,
} from './project.js';

export type SkillShareLink = {
  userId: string;
  directory: string;
  unit: string;
};
export type InstalledSkillShareLink = SkillShareLink & {
  project?: SkillProject;
};

export function projectSharedSkillsRoot(root: string, projectId: string) {
  if (!projectIdSchema.safeParse(projectId).success)
    throw new SkillError('PROJECT_NOT_FOUND', 404);
  return resolve(root, '.agents', 'project-skills', projectId);
}

function managedRoot(root: string, store: string) {
  const parts = relative(resolve(root), store).split(sep);
  return (
    parts[0] === '.agents' &&
    ((parts.length === 2 && parts[1] === 'skills') ||
      (parts.length === 3 &&
        parts[1] === 'project-skills' &&
        projectIdSchema.safeParse(parts[2]).success))
  );
}

async function info(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
}

async function checkedPath(root: string, path: string) {
  const suffix = relative(root, path);
  if (suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix))
    return false;
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!(await info(current))?.isDirectory()) return false;
  }
  return true;
}

export async function readSkillShareLink(
  root: string,
  store: string,
  unit: string,
): Promise<SkillShareLink | undefined> {
  if (
    !managedRoot(root, store) ||
    !safeRepositoryPath(unit) ||
    unit.split('/').some((part) => part.startsWith('.'))
  )
    return;
  if (
    store === resolve(root, '.agents', 'skills') &&
    ['builtin', 'plugins'].includes(unit.split('/')[0].toLowerCase())
  )
    return;
  const alias = join(store, unit);
  if (
    !(await checkedPath(root, dirname(alias))) ||
    !(await info(alias))?.isSymbolicLink()
  )
    return;
  const raw = await readlink(alias).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'EINVAL') return undefined;
    throw error;
  });
  if (!raw) return;
  const directory = resolve(dirname(alias), raw);
  const parts = relative(resolve(root, 'users'), directory).split(sep);
  const userId = parts[0];
  if (
    !/^[a-zA-Z0-9_-]+$/.test(userId) ||
    directory !== resolve(root, 'users', userId, '.agents', 'skills', unit) ||
    (raw !== directory && raw !== relative(dirname(alias), directory))
  )
    return;
  return { userId, directory, unit };
}

export async function resolveSkillShareLink(
  root: string,
  store: string,
  unit: string,
): Promise<InstalledSkillShareLink | undefined> {
  const link = await readSkillShareLink(root, store, unit);
  if (!link || !(await checkedPath(root, link.directory))) return;
  const parts = unit.split('/');
  let dir = resolve(root, 'users', link.userId, '.agents', 'skills');
  try {
    for (let index = 0; index < parts.length; index++) {
      if (await info(join(dir, 'SKILL.md'))) return;
      if (
        index > 0 &&
        index <= 2 &&
        (await readSkillProject(dir, { legacy: index === 2 }))
      )
        return;
      dir = join(dir, parts[index]);
    }
    const project =
      parts.length <= 2
        ? await readSkillProject(dir, { legacy: parts.length === 2 })
        : undefined;
    if (project) {
      for (const entry of project.entries) {
        const manifest = await info(join(dir, project.root, entry.path));
        if (!manifest?.isFile() || manifest.nlink !== 1) return;
      }
      return { ...link, project };
    }
    const manifest = await info(join(dir, 'SKILL.md'));
    if (manifest?.isFile() && manifest.nlink === 1) return link;
  } catch (error) {
    if (error instanceof SkillError && error.code === 'SKILL_PROJECT_INVALID')
      return;
    throw error;
  }
}

// Only read directory entries. Native packages are leaves, so group libraries and
// large whole-project imports are never walked while enumerating shares.
export async function listSkillShareLinks(
  root: string,
  store: string,
  userId?: string,
): Promise<SkillShareLink[]> {
  if (!managedRoot(root, store) || !(await checkedPath(root, store))) return [];
  const links: SkillShareLink[] = [];
  async function visit(dir: string, prefix: string, depth: number) {
    const items = await readdir(dir, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
        throw error;
      },
    );
    if (
      items.some(
        (entry) =>
          (entry.name === 'SKILL.md' && entry.isFile()) ||
          ((depth === 1 || depth === 2) &&
            entry.name === SKILL_META_DIRECTORY) ||
          (depth === 2 && entry.name === SKILL_PROJECT_FILE),
      )
    )
      return;
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      if (
        depth === 0 &&
        store === resolve(root, '.agents', 'skills') &&
        ['builtin', 'plugins'].includes(item.name.toLowerCase())
      )
        continue;
      const unit = prefix ? prefix + '/' + item.name : item.name;
      if (item.isSymbolicLink()) {
        const link = await readSkillShareLink(root, store, unit);
        if (link && (!userId || userId === link.userId)) links.push(link);
      } else if (item.isDirectory()) {
        await visit(join(dir, item.name), unit, depth + 1);
      }
    }
  }
  await visit(store, '', 0);
  return links;
}

export async function withSkillShareLock<T>(
  root: string,
  store: string,
  unit: string,
  action: () => Promise<T>,
  options: { catalog?: boolean } = {},
): Promise<T> {
  if (
    !managedRoot(root, store) ||
    !safeRepositoryPath(unit) ||
    !(await checkedPath(root, store))
  )
    throw new SkillError('SKILL_UNSAFE_PATH', 403);
  const paths = [join(store, '.' + unit.split('/')[0] + '.skill-install.lock')];
  // Different repositories can publish the same runtime name. Serialize that
  // catalog-wide check across server processes as well as in-process services.
  if (options.catalog) paths.unshift(join(store, '.skill-share-catalog.lock'));
  const held: string[] = [];
  try {
    for (const lock of paths) {
      await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST')
          throw new SkillError('SKILL_CONFLICT', 409);
        throw error;
      });
      held.push(lock);
    }
    return await action();
  } finally {
    for (const lock of held.reverse()) await rmdir(lock);
  }
}

export async function clearPersonalSkillShares(
  root: string,
  userId: string,
  units: string[],
) {
  const stores = [resolve(root, '.agents', 'skills')];
  const projects = resolve(root, '.agents', 'project-skills');
  if (await checkedPath(root, projects))
    for (const entry of await readdir(projects, { withFileTypes: true }))
      if (entry.isDirectory() && projectIdSchema.safeParse(entry.name).success)
        stores.push(projectSharedSkillsRoot(root, entry.name));
  const grants: { store: string; unit: string }[] = [];
  const locks = new Map<string, { store: string; top: string }>();
  for (const store of stores) {
    for (const unit of new Set(units)) {
      if ((await readSkillShareLink(root, store, unit))?.userId !== userId)
        continue;
      grants.push({ store, unit });
      const top = unit.split('/')[0];
      locks.set(join(store, top), { store, top });
    }
  }
  // Acquire every destination lock before changing the first grant. A competing
  // publish can then be retried without partially unsharing the source.
  const held = [...locks.values()];
  async function remove(index: number): Promise<void> {
    if (index < held.length) {
      const { store, top } = held[index];
      return withSkillShareLock(root, store, top, () => remove(index + 1));
    }
    const removed: { alias: string; target: string; store: string }[] = [];
    try {
      for (const { store, unit } of grants) {
        const link = await readSkillShareLink(root, store, unit);
        if (link?.userId !== userId) continue;
        const alias = join(store, unit);
        await unlink(alias);
        removed.push({
          alias,
          target: relative(dirname(alias), link.directory),
          store,
        });
      }
    } catch (error) {
      for (const { alias, target } of removed)
        await symlink(target, alias, 'dir');
      throw error;
    }
    for (const { alias, store } of removed)
      await pruneEmptySkillParents(dirname(alias), store);
  }
  await remove(0);
}
