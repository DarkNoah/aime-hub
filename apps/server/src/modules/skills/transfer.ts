import { randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { InstalledSkill } from '@aime/shared/skills';
import { SkillError } from './errors.js';
import { SKILL_META_DIRECTORY, pruneSkillArchiveGroup } from './project.js';
import {
  readSkillSources,
  serializeSkillSources,
  SKILL_SOURCES_FILE,
  type SkillSource,
} from './sources.js';

export type SkillTransferOptions = {
  verify: (directory: string, entries: InstalledSkill[]) => Promise<void>;
  commit: (directory: string, entries: InstalledSkill[]) => Promise<void>;
};

async function optionalStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

// An empty group would block a later whole-project installation. Stop at
// the first retained file, sibling group, or directory we cannot remove.
export async function pruneEmptySkillParents(path: string, root: string) {
  while (path.startsWith(root + sep)) {
    if (await pruneSkillArchiveGroup(path).catch(() => false)) {
      path = dirname(path);
      continue;
    }
    const removed = await rmdir(path).then(
      () => true,
      () => false,
    );
    if (!removed) return;
    path = dirname(path);
  }
}

async function isTransferDirectory(path: string) {
  const info = await lstat(path);
  if (info.isDirectory()) return true;
  if (info.isFile() && info.nlink === 1) return false;
  throw new SkillError('SKILL_UNSAFE_PATH', 403);
}

export async function assertTransferTree(path: string): Promise<void> {
  if (!(await isTransferDirectory(path))) return;
  for (const child of await readdir(path))
    await assertTransferTree(join(path, child));
}

async function grantDirectoryRemoval(path: string) {
  const info = await optionalStat(path);
  if (!info?.isDirectory()) return;
  await chmod(path, info.mode | 0o700);
  for (const name of await readdir(path))
    await grantDirectoryRemoval(join(path, name));
}

async function discardTree(path: string) {
  const options = { recursive: true, force: true, maxRetries: 3 };
  try {
    await rm(path, options);
  } catch (error) {
    if (
      !['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error;
    // A published package may contain read-only directories. Adjust only the
    // discarded tree, after the operation no longer needs it for rollback.
    await grantDirectoryRemoval(path);
    await rm(path, options);
  }
}

async function assertVacant(path: string) {
  if (await optionalStat(path)) throw new SkillError('SKILL_CONFLICT', 409);
}

/** Across mounts, retain the original inode for rollback until provenance commits. */
async function publishDirectory(
  source: string,
  destination: string,
): Promise<string | undefined> {
  await assertVacant(destination);
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const token = '.skill-transfer-' + randomUUID();
  const backup = join(dirname(source), token);
  const copy = join(dirname(destination), token);
  await rename(source, backup);
  try {
    await cp(backup, copy, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (path) => {
        await isTransferDirectory(path);
        return true;
      },
    });
    await assertVacant(destination);
    await rename(copy, destination);
    return backup;
  } catch (error) {
    try {
      await rename(backup, source);
    } finally {
      await discardTree(copy);
    }
    throw error;
  }
}

type SourceChange = {
  file: string;
  before: string | null;
  after: string | null;
};

async function sourceChange(
  directory: string,
  records: SkillSource[],
  next: SkillSource[],
) {
  if (JSON.stringify(records) === JSON.stringify(next)) return [];
  const metadata = join(directory, SKILL_META_DIRECTORY);
  const info = await optionalStat(metadata);
  if (info && !info.isDirectory())
    throw new SkillError('SKILL_UNSAFE_PATH', 403);
  const file = join(info ? metadata : directory, SKILL_SOURCES_FILE);
  const before = records.length ? await readFile(file, 'utf8') : null;
  return [
    { file, before, after: next.length ? serializeSkillSources(next) : null },
  ];
}

async function transferSources(
  source: string,
  destination: string,
  skill: InstalledSkill,
  hasSiblings: boolean,
): Promise<SourceChange[]> {
  // Whole-project metadata travels inside the package. Ordinary GitHub
  // installations keep provenance in the parent shared by sibling entries.
  if (skill.projectRoot || skill.sourceType === 'archive') return [];
  const previous = await readSkillSources(source);
  const records = previous.filter(
    ({ installation }) =>
      installation?.mode !== 'package' || installation.name === skill.name,
  );
  if (!records.length)
    return hasSiblings ? [] : sourceChange(source, previous, []);
  const existing = await readSkillSources(destination);
  const merged = new Map(existing.map((record) => [record.url, record]));
  for (const record of records) {
    const current = merged.get(record.url);
    if (current && JSON.stringify(current) !== JSON.stringify(record))
      throw new SkillError('SKILL_CONFLICT', 409);
    merged.set(record.url, record);
  }
  const remaining = hasSiblings
    ? previous.filter(
        ({ installation }) =>
          installation?.mode !== 'package' || installation.name !== skill.name,
      )
    : [];
  return [
    ...(await sourceChange(destination, existing, [...merged.values()])),
    ...(await sourceChange(source, previous, remaining)),
  ];
}

async function writeSources(path: string, content: string | null) {
  if (content === null) {
    await rm(path);
    return;
  }
  const temporary = join(dirname(path), `.skill-transfer-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function moveSkillDirectory(
  source: string,
  destination: string,
  skill: InstalledSkill,
  hasSiblings: boolean,
  commit: () => Promise<void> | undefined,
) {
  await assertTransferTree(source);
  const changes = await transferSources(
    dirname(source),
    dirname(destination),
    skill,
    hasSiblings,
  );
  // Never replace even an empty directory. The source and target group locks
  // serialize this check with both application and CLI installations.
  const backup = await publishDirectory(source, destination);
  const written: SourceChange[] = [];
  try {
    for (const change of changes) {
      await writeSources(change.file, change.after);
      written.push(change);
    }
    await commit();
  } catch (error) {
    const failures: unknown[] = [];
    for (const change of written.reverse()) {
      try {
        await writeSources(change.file, change.before);
      } catch (failure) {
        failures.push(failure);
      }
    }
    try {
      await rename(backup ?? destination, source);
      if (backup) await discardTree(destination);
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        'Could not restore the skill transfer',
      );
    throw error;
  }
  if (backup) await discardTree(backup);
}
