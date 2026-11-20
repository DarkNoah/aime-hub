import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type {
  InstalledSkill,
  SkillDestination,
  SkillSharing,
} from '@aime/shared/skills';
import { SkillError } from './errors.js';
import type { SkillService } from './service.js';
import { safeRepositoryPath } from './github.js';

type Origin = { sharing: SkillSharing; unit: string; token: string };
type ProjectTarget = { id: string; name: string };

function unit(skill: InstalledSkill) {
  return skill.projectRoot ? skill.group : skill.path;
}

function scopeKey(target: SkillDestination) {
  return target.scope === 'global' ? 'global' : target.projectId;
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function locationKey(target: SkillDestination, installation: string) {
  return digest(JSON.stringify([scopeKey(target), installation]));
}

function marker(directory: string, origin: Origin) {
  return join(
    directory,
    '.skill-origin-' + locationKey(origin.sharing, origin.unit),
  );
}

async function stat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

async function matches(directory: string, origin: Origin) {
  if (!(await stat(directory))?.isDirectory()) return false;
  const path = marker(directory, origin);
  const file = await stat(path);
  if (!file?.isFile() || file.size !== 36) return false;
  try {
    return (await readFile(path, 'utf8')) === origin.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Update prior move-to-share provenance after the owning archive directory moves. */
export async function migrateSkillOriginUnits(
  workspaceRoot: string,
  target: SkillDestination,
  storeRoot: string,
  moves: ReadonlyMap<string, string>,
) {
  if (!moves.size) return;
  const registry = join(workspaceRoot, '.agents', 'skill-origins');
  const info = await stat(registry);
  if (!info) return;
  if (!info.isDirectory()) throw new SkillError('SKILL_UNSAFE_PATH', 403);
  const locations = new Set(
    [...moves.keys()].map((unit) => locationKey(target, unit)),
  );
  const files = await readdir(registry);
  for (const filename of files) {
    if (!locations.has(filename.split('.')[0])) continue;
    if (!/^[a-f\d]{64}\.[a-f\d]{64}\.json$/.test(filename)) continue;
    const oldFile = join(registry, filename);
    const originalInfo = await stat(oldFile);
    if (!originalInfo?.isFile()) throw new SkillError('SKILL_UNSAFE_PATH', 403);
    const original: Origin = JSON.parse(await readFile(oldFile, 'utf8'));
    if (!original.sharing || scopeKey(original.sharing) !== scopeKey(target))
      continue;
    const nextUnit = moves.get(original.unit);
    if (!nextUnit || nextUnit === original.unit) continue;
    if (
      !safeRepositoryPath(original.unit) ||
      !safeRepositoryPath(nextUnit) ||
      typeof original.token !== 'string' ||
      typeof original.sharing.userId !== 'string'
    )
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    const expected =
      locationKey(original.sharing, original.unit) +
      '.' +
      digest(original.sharing.userId) +
      '.json';
    if (filename !== expected) throw new SkillError('SKILL_UNSAFE_PATH', 403);
    const next: Origin = { ...original, unit: nextUnit };
    const directory = join(storeRoot, nextUnit);
    const nextMarker = marker(directory, next);
    const oldMarker = marker(directory, original);
    // An old publisher record can outlive its installation. Transfer only a
    // grant whose on-disk proof still belongs to this package and publisher.
    if (
      !(await matches(directory, original)) &&
      !(await matches(directory, next))
    )
      continue;
    const markerInfo = await stat(nextMarker);
    if (markerInfo) {
      if (!(await matches(directory, next)))
        throw new SkillError('SKILL_CONFLICT', 409);
    } else await rename(oldMarker, nextMarker);
    const nextFile = join(
      registry,
      locationKey(next.sharing, next.unit) +
        '.' +
        digest(next.sharing.userId) +
        '.json',
    );
    const existing = await stat(nextFile);
    if (existing) {
      if (
        !existing.isFile() ||
        JSON.stringify(JSON.parse(await readFile(nextFile, 'utf8'))) !==
          JSON.stringify(next)
      )
        throw new SkillError('SKILL_CONFLICT', 409);
    } else {
      const temporary = nextFile + '.migrating-' + randomUUID();
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx' });
      try {
        await rename(temporary, nextFile);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await rm(oldMarker, { force: true });
    await rm(oldFile, { force: true });
  }
}

/** Provenance for previous installations physically moved out of a personal directory. */
export class SkillOrigins {
  private readonly directory: string;

  constructor(globalSkillRoot: string) {
    this.directory = join(dirname(globalSkillRoot), 'skill-origins');
  }

  private async exists() {
    for (const path of [dirname(this.directory), this.directory]) {
      const info = await stat(path);
      if (!info) return false;
      if (!info.isDirectory()) throw new SkillError('SKILL_UNSAFE_PATH', 403);
    }
    return true;
  }

  private file(sharing: SkillSharing, path: string) {
    return join(
      this.directory,
      locationKey(sharing, path) + '.' + digest(sharing.userId) + '.json',
    );
  }

  private async read(file: string): Promise<Origin | undefined> {
    const info = await stat(file);
    if (!info) return;
    if (!info.isFile()) throw new SkillError('SKILL_UNSAFE_PATH', 403);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Origin;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async records(include: (location: string, owner: string) => boolean) {
    if (!(await this.exists())) return [];
    const names = (await readdir(this.directory)).filter((name) => {
      const [location, owner, extension] = name.split('.');
      return extension === 'json' && include(location, owner);
    });
    const records = await Promise.all(
      names.map((name) => this.read(join(this.directory, name))),
    );
    return records.filter((record): record is Origin => !!record);
  }

  /** Restore installations created by the previous move-to-share implementation. */
  async restore(global: SkillService, path: string, sharing: SkillSharing) {
    if (!(await this.exists())) throw new SkillError('SKILL_NOT_FOUND', 404);
    let origin: Origin;
    return global.restoreMovedPersonal(sharing.userId, path, sharing, {
      verify: async (directory, [skill]) => {
        const installation = unit(skill);
        const record = await this.read(this.file(sharing, installation));
        if (
          !record ||
          record.sharing.userId !== sharing.userId ||
          scopeKey(record.sharing) !== scopeKey(sharing) ||
          record.unit !== installation ||
          !(await matches(directory, record))
        )
          throw new SkillError('FORBIDDEN', 403);
        origin = record;
      },
      commit: async (directory) => {
        const token = marker(directory, origin);
        await rm(token);
        try {
          await rm(this.file(origin.sharing, origin.unit));
        } catch (error) {
          await writeFile(token, origin.token, { flag: 'wx' });
          throw error;
        }
      },
    });
  }

  private async at(target: SkillDestination, directories: Map<string, string>) {
    const found = new Map<string, Origin>();
    if (!directories.size) return found;
    const keys = new Set(
      [...directories.keys()].map((path) => locationKey(target, path)),
    );
    const records = await this.records((location) => keys.has(location));
    for (const record of records) {
      const directory = directories.get(record.unit);
      if (
        directory &&
        scopeKey(record.sharing) === scopeKey(target) &&
        (await matches(directory, record))
      )
        found.set(record.unit, record);
    }
    return found;
  }

  async find(
    target: SkillDestination,
    root: string,
    installations: Iterable<string>,
  ) {
    const directories = new Map(
      [...installations].map((path) => [path, join(root, path)]),
    );
    const records = await this.at(target, directories);
    return new Map(
      [...records].map(([path, record]) => [path, record.sharing]),
    );
  }

  async annotateGlobal(root: string, skills: InstalledSkill[]) {
    const records = await this.find(
      { scope: 'global' },
      root,
      skills.filter((skill) => !skill.sharing).map(unit),
    );
    return skills.map((skill) => {
      const sharing = records.get(unit(skill));
      return sharing && !skill.sharing
        ? { ...skill, sharing: { ...sharing, legacyMoved: true as const } }
        : skill;
    });
  }

  async sharedBy(
    userId: string,
    admin: boolean,
    projects: ProjectTarget[],
    list: (
      scope: SkillDestination,
    ) => Promise<{ root: string; skills: InstalledSkill[] }>,
  ) {
    const allowed = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const owner = digest(userId);
    const records = await this.records(
      (_location, publisher) => owner === publisher,
    );
    const scopes = new Map<string, Origin[]>();
    for (const record of records) {
      const target = record.sharing;
      if (
        target.userId !== userId ||
        (target.scope === 'global' ? !admin : !allowed.has(target.projectId))
      )
        continue;
      const scope = scopeKey(target);
      const group = scopes.get(scope) ?? [];
      group.push(record);
      scopes.set(scope, group);
    }
    const results = await Promise.all(
      [...scopes.values()].map(async (group) => {
        const catalog = await list(group[0].sharing);
        const installed = new Set(
          catalog.skills.filter((skill) => !skill.sharing).map(unit),
        );
        const current = new Map<string, SkillSharing>();
        for (const record of group) {
          if (
            !installed.has(record.unit) ||
            !(await matches(join(catalog.root, record.unit), record))
          )
            continue;
          const sharing = record.sharing;
          current.set(
            record.unit,
            sharing.scope === 'project'
              ? { ...sharing, projectName: allowed.get(sharing.projectId) }
              : sharing,
          );
        }
        return catalog.skills.flatMap((skill) => {
          const sharing = current.get(unit(skill));
          return sharing && !skill.sharing
            ? [
                {
                  ...skill,
                  sharing: { ...sharing, legacyMoved: true as const },
                },
              ]
            : [];
        });
      }),
    );
    return results.flat();
  }

  /** Copy only verified publisher markers when an in-place repository update
   * replaces directories. A failed update restores the original directories. */
  async replacedGlobalGroup(
    previousRoot: string,
    before: InstalledSkill[],
    nextRoot: string,
    after: InstalledSkill[],
  ) {
    if (!before.length || !after.length) return;
    const group = before[0].group;
    const next = new Set(after.map(unit));
    const directories = new Map(
      before
        .map(unit)
        .filter((path) => next.has(path))
        .map((path) => [path, join(previousRoot, relative(group, path))]),
    );
    const records = await this.at({ scope: 'global' }, directories);
    for (const [path, record] of records)
      await writeFile(
        marker(join(nextRoot, relative(group, path)), record),
        record.token,
        { flag: 'wx' },
      );
  }
}
