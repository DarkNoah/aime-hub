import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

// This group belongs to the application. Other global groups remain user-managed.
export const BUILTIN_SKILL_GROUP = 'builtin';

export function copyBuiltinSkillFiles(
  source: string | URL,
  target: string | URL,
) {
  return cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (file) =>
      !['.DS_Store', '.git', '__pycache__'].includes(basename(file)) &&
      !(await lstat(file)).isSymbolicLink(),
  });
}

async function info(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function skillPackages(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      if (directory === root)
        throw new Error('Place each bundled skill in its own directory');
      result.push(relative(root, directory));
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.'))
        await visit(join(directory, entry.name));
    }
  }
  await visit(root);
  return result;
}

/** Refresh the application-owned global skills before accepting requests. */
export async function syncBuiltinSkills(
  sourceDirectory: string,
  workspaceRoot: string,
) {
  const source = resolve(sourceDirectory);
  const sourceInfo = await info(source);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error(
      `Bundled skills directory is missing or invalid: ${source}`,
    );
  const packages = await skillPackages(source);
  let directory = resolve(workspaceRoot);
  for (const part of ['', '.agents', 'skills']) {
    directory = join(directory, part);
    await mkdir(directory, { recursive: true });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Invalid global skills directory: ${directory}`);
  }
  if (await info(join(directory, 'SKILL.md')))
    throw new Error('The global skills root must contain skill directories');
  const target = join(directory, BUILTIN_SKILL_GROUP);
  const targetInfo = await info(target);
  if (targetInfo && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()))
    throw new Error(`Invalid built-in skills directory: ${target}`);

  const staging = await mkdtemp(join(directory, '.builtin-sync-'));
  const next = join(staging, 'next');
  const previous = join(staging, 'previous');
  let backedUp = false;
  let installed = false;
  try {
    await mkdir(next);
    for (const path of packages) {
      await copyBuiltinSkillFiles(join(source, path), join(next, path));
    }
    if (targetInfo) {
      await rename(target, previous);
      backedUp = true;
    }
    await rename(next, target);
    installed = true;
  } catch (error) {
    if (backedUp && !installed) {
      try {
        await rename(previous, target);
        backedUp = false;
      } catch (restoreError) {
        // Keep the backup if the filesystem also prevents restoring it.
        throw new AggregateError(
          [error, restoreError],
          `Could not restore built-in skills; backup preserved at ${previous}`,
        );
      }
    }
    throw error;
  } finally {
    if (!backedUp || installed)
      await rm(staging, { recursive: true, force: true });
  }
  return { directory: target, count: packages.length };
}
