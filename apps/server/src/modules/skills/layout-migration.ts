import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { SkillDestination } from '@aime/shared/skills';
import { migrateSkillOriginUnits } from './origins.js';
import {
  readSkillProject,
  skillProjectSchema,
  SKILL_META_DIRECTORY as meta,
  SKILL_PROJECT_FILE as projectFile,
  SKILL_ARCHIVE_FILE as archiveFile,
} from './project.js';
import { safeRepositoryPath } from './github.js';
import { readSkillShareLink } from './share-links.js';
import { SKILL_SOURCES_FILE as sourcesFile } from './sources.js';
import { LayoutLocks } from './layout-locks.js';
import {
  applyLayoutStep,
  atomicJson,
  conflict,
  directoriesExist,
  fileInfo,
  identity,
  type LayoutStep,
} from './layout-journal.js';

const globalStore = '.agents/skills';
type Mapping = [string, string];
type Unit = { old: string; next: string; entries: Mapping[] };
type Store = {
  path: string;
  user?: string;
  target?: SkillDestination;
  links?: boolean;
  mounted?: boolean;
};
type Plan = {
  id: string;
  database?: string;
  locks: string[];
  planning?: boolean;
  committed?: boolean;
  steps: LayoutStep[];
  globals: Mapping[];
  origins: { store: string; target: SkillDestination; moves: Mapping[] }[];
};

async function stores(root: string) {
  const result: Store[] = [
    { path: globalStore, target: { scope: 'global' }, links: true },
  ];
  for (const base of ['users', 'projects', '.agents/project-skills']) {
    const path = join(root, base);
    if (!(await directoriesExist(root, path))) continue;
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const id = item.name;
      if (base === 'users') {
        if (/^[\w-]+$/.test(id))
          result.push({ path: join(base, id, '.agents/skills'), user: id });
      } else if (/^[\w-]{16}$/.test(id)) {
        const shared = base.startsWith('.agents/');
        // A live AgentFS mount belongs to the process that initialized it; its
        // own journal is recovered under the mounted database's identity.
        if (
          !shared &&
          (await fileInfo(join(path, id + '.db')))?.isFile() &&
          (await fileInfo(join(path, id)))?.dev !== (await fileInfo(path))?.dev
        )
          continue;
        result.push({
          path: join(base, id, shared ? '' : '.agents/skills'),
          target: { scope: 'project', projectId: id },
          links: shared,
        });
      }
    }
  }
  return result;
}

class BlockedGroup extends Error {
  constructor(
    readonly group: string,
    store: string,
    cause: unknown,
  ) {
    super(
      `技能目录 ${join(store, group)} 未迁移：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

type GroupChanges = {
  steps: LayoutStep[];
  units: Unit[];
  links: Set<string>;
  locks: LayoutLocks;
};

async function planGroup(
  root: string,
  store: Store,
  old: string,
  next: string,
  changes: GroupChanges,
) {
  const { steps, units, links } = changes;
  const dir = join(root, store.path);
  async function move(original: string, from: string, path: string) {
    if (!safeRepositoryPath(from) || !safeRepositoryPath(path))
      conflict(original);
    const info = await fileInfo(join(root, original));
    if (!info) conflict(original);
    steps.push({ op: 'move', from, path, id: identity(info, store.mounted) });
  }
  async function vacant(path: string) {
    if (await fileInfo(join(root, path))) conflict(join(root, path));
  }

  const before = join(store.path, old);
  const after = join(store.path, next);
  const absolute = join(root, before);
  await changes.locks.group(store.path, old, next);
  if (old !== next) {
    if (
      store.path === globalStore &&
      ['plugins', 'builtin'].includes(next.toLowerCase())
    )
      conflict(after);
    await vacant(after);
  }
  if ((await fileInfo(absolute))?.isSymbolicLink()) {
    if (!store.links || !(await readSkillShareLink(root, dir, old)))
      conflict(absolute);
    await move(before, before, after);
    links.add(old);
    return;
  }
  const outer = await readdir(absolute, { withFileTypes: true });
  const project = await readSkillProject(absolute, { legacy: true });
  if (project) {
    const entries = project.entries.map(({ path }): Mapping => [
      join(old, project.root, dirname(path)),
      join(next, dirname(path)),
    ]);
    units.push({ old, next, entries });
    if (project.version === 2) {
      if (old !== next) await move(before, before, after);
      return;
    }
    const metadata = { version: 2, root: '.', entries: project.entries };
    skillProjectSchema.parse(metadata);
    const tree = join(before, 'project');
    const upstream = await readdir(join(root, tree));
    const upstreamMeta = upstream.find((name) => name.toLowerCase() === meta);
    if (upstreamMeta) {
      if (
        upstreamMeta !== meta ||
        !(await fileInfo(join(root, tree, meta)))?.isDirectory()
      )
        conflict(join(tree, upstreamMeta));
      for (const name of await readdir(join(root, tree, meta))) {
        if (
          [projectFile, sourcesFile, archiveFile].includes(name.toLowerCase())
        )
          conflict(join(tree, meta, name));
      }
    }
    const stage = join(store.path, `.skill-layout-${randomUUID()}`);
    await vacant(stage);
    await move(before, before, stage);
    await move(tree, join(stage, 'project'), after);
    steps.push({ op: 'mkdir', path: join(after, meta) });
    steps.push({
      op: 'write',
      path: join(after, meta, projectFile),
      content: JSON.stringify(metadata),
    });
    for (const file of outer) {
      if (file.name === 'project') continue;
      const original = join(before, file.name);
      const staged = join(stage, file.name);
      if (file.name === projectFile) {
        const info = await fileInfo(join(root, original));
        if (!info?.isFile()) conflict(original);
        steps.push({
          op: 'unlink',
          path: staged,
          id: identity(info, store.mounted),
        });
      } else {
        const dest =
          file.name === sourcesFile
            ? join(after, meta, sourcesFile)
            : join(after, file.name);
        if (file.name === sourcesFile) {
          if (!file.isFile()) conflict(original);
        } else if (
          upstream.some(
            (name) => name.toLowerCase() === file.name.toLowerCase(),
          )
        )
          conflict(dest);
        await move(original, staged, dest);
      }
    }
    steps.push({ op: 'rmdir', path: stage });
  } else {
    // Ordinary archive packages are direct children, including individual shares.
    await move(before, before, after);
    for (const child of outer) {
      if (child.name.startsWith('.')) continue;
      const from = join(old, child.name);
      if (child.isSymbolicLink()) {
        if (!store.links || !(await readSkillShareLink(root, dir, from)))
          conflict(join(dir, from));
        links.add(from);
      } else if (
        child.isDirectory() &&
        (await fileInfo(join(absolute, child.name, 'SKILL.md')))?.isFile()
      ) {
        const to = join(next, child.name);
        units.push({ old: from, next: to, entries: [[from, to]] });
      }
    }
    steps.push(
      { op: 'mkdir', path: join(after, meta) },
      {
        op: 'write',
        path: join(after, meta, archiveFile),
        content: JSON.stringify({ version: 1 }),
      },
    );
  }
}

async function planLayouts(
  root: string,
  catalogs: Store[],
  skipped: ReadonlySet<string>,
  locks: LayoutLocks,
): Promise<Plan> {
  const plan: Plan = {
    id: locks.id,
    locks: [],
    steps: [],
    globals: [],
    origins: [],
  };
  const personal = new Map<string, Unit[]>();
  const grants = new Map<string, Set<string>>();
  const globals = new Map<string, string>();
  const cleanup: LayoutStep[] = [];
  for (const store of catalogs) {
    const dir = join(root, store.path);
    if (!(await directoriesExist(root, dir))) continue;
    const units: Unit[] = [];
    const links = new Set<string>();
    grants.set(store.path, links);
    const changes = { steps: plan.steps, units, links, locks };
    for (const top of await readdir(dir, { withFileTypes: true })) {
      if (!top.isDirectory() || top.name.startsWith('.')) continue;
      const first = join(dir, top.name);
      if (top.name === '@local') {
        if (skipped.has('@local')) continue;
        try {
          await locks.group(store.path, '@local');
        } catch (error) {
          throw new BlockedGroup('@local', dir, error);
        }
        const contents = await readdir(first, { withFileTypes: true });
        for (const item of contents) {
          if (item.name.startsWith('.')) continue;
          const unit = join(top.name, item.name);
          if (skipped.has(unit)) continue;
          try {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name))
              conflict(join(dir, unit));
            await planGroup(root, store, unit, item.name, changes);
          } catch (error) {
            throw new BlockedGroup(unit, dir, error);
          }
        }
        if (
          contents.every(
            (item) =>
              (item.name === '.DS_Store' && item.isFile()) ||
              (!item.name.startsWith('.') &&
                !skipped.has(join(top.name, item.name))),
          )
        ) {
          const finderPath = join(store.path, top.name, '.DS_Store');
          const finder = await fileInfo(join(root, finderPath));
          if (finder) {
            if (!finder.isFile()) conflict(finderPath);
            cleanup.push({
              op: 'unlink',
              path: finderPath,
              id: identity(finder, store.mounted),
            });
          }
          cleanup.push({ op: 'rmdir', path: join(store.path, top.name) });
        }
        continue;
      }
      if (
        store.path === globalStore &&
        ['builtin', 'plugins'].includes(top.name.toLowerCase())
      )
        continue;
      if (
        (await fileInfo(join(first, meta))) ||
        (await fileInfo(join(first, 'SKILL.md')))
      )
        continue;
      for (const repo of await readdir(first, { withFileTypes: true })) {
        if (!repo.isDirectory() || repo.name.startsWith('.')) continue;
        const unit = join(top.name, repo.name);
        const path = join(dir, unit);
        if (
          skipped.has(unit) ||
          !(await fileInfo(join(path, projectFile))) ||
          (await fileInfo(join(path, meta))) ||
          !(await fileInfo(join(path, 'project')))?.isDirectory()
        )
          continue;
        try {
          await planGroup(root, store, unit, unit, changes);
        } catch (error) {
          throw new BlockedGroup(unit, dir, error);
        }
      }
    }
    if (store.user) personal.set(store.user, units);
    if (store.path === globalStore)
      for (const unit of units)
        for (const [old, next] of unit.entries) globals.set(old, next);
    const moves = units
      .filter((u) => u.old !== u.next)
      .map((u): Mapping => [u.old, u.next]);
    if (store.target && moves.length)
      plan.origins.push({ target: store.target, store: store.path, moves });
  }
  // Resolve grants while their old targets and canonical relative links still exist.
  const changedUnits = new Set([...personal.values()].flat().map((u) => u.old));
  for (const store of catalogs.filter((s) => s.links)) {
    const names = grants.get(store.path);
    if (!names) continue;
    for (const unit of new Set([...names, ...changedUnits])) {
      let source = await readSkillShareLink(root, join(root, store.path), unit);
      if (!source) continue;
      try {
        await locks.group(store.path, unit, unit.replace(/^@local\//, ''));
      } catch (error) {
        throw new BlockedGroup(
          unit.split('/').slice(0, 2).join('/'),
          join(root, store.path),
          error,
        );
      }
      source = await readSkillShareLink(root, join(root, store.path), unit);
      if (!source) continue;
      const moved = personal.get(source.userId)?.find((u) => u.old === unit);
      const next = moved?.next ?? unit.replace(/^@local\//, '');
      if (unit !== next) {
        const oldPath = join(root, store.path, unit);
        const info = await fileInfo(oldPath);
        if (!info?.isSymbolicLink()) conflict(oldPath);
        const path = join(store.path, next);
        const target = relative(
          dirname(join(root, path)),
          join(root, 'users', source.userId, '.agents/skills', next),
        );
        plan.steps.push(
          { op: 'unlink', path, id: identity(info) },
          { op: 'link', path, target },
        );
      }
      if (store.path === globalStore)
        for (const [old, path] of moved?.entries ?? [[unit, next]])
          globals.set(old, path);
    }
  }
  plan.globals = [...globals].filter(([from, to]) => from !== to);
  plan.steps.push(...cleanup);
  return plan;
}

/** Called under the startup advisory lock. The saved plan includes global aliases,
 * so a restart after a filesystem move can still repair historical Agent versions. */
export async function migrateSkillLayouts(
  workspaceRoot: string,
  onGlobalPaths: (
    paths: ReadonlyMap<string, string>,
    migrationId: string,
  ) => Promise<unknown>,
) {
  const root = resolve(workspaceRoot);
  return migrateStores(root, await stores(root), '', onGlobalPaths);
}

// Simple AgentFS project workspaces become visible only after their first mount.
export async function migrateMountedProjectSkills(directory: string) {
  const id = basename(directory);
  if (basename(dirname(directory)) !== 'projects' || !/^[\w-]{16}$/.test(id))
    return [];
  const root = dirname(dirname(directory));
  const database = await fileInfo(directory + '.db');
  if (database && !database.isFile()) conflict(directory + '.db');
  return migrateStores(
    root,
    [
      {
        path: join('projects', id, '.agents/skills'),
        mounted: !!database,
        target: { scope: 'project', projectId: id },
      },
    ],
    '-' + id,
    undefined,
    database ? identity(database) : undefined,
  );
}

async function migrateStores(
  root: string,
  catalogs: Store[],
  suffix: string,
  onGlobalPaths?: (
    paths: ReadonlyMap<string, string>,
    migrationId: string,
  ) => Promise<unknown>,
  database?: string,
) {
  const state = join(root, '.agents');
  const stateInfo = await fileInfo(state);
  if (stateInfo && !stateInfo.isDirectory()) conflict(state);
  const journal = join(state, `.skill-layout-migration${suffix}.json`);
  const cursor = join(state, `.skill-layout-progress${suffix}.json`);
  async function saved(path: string) {
    const info = await fileInfo(path);
    if (!info) return undefined;
    if (!info.isFile() || info.nlink !== 1n) conflict(path);
    return JSON.parse(await readFile(path, 'utf8'));
  }
  let pending = (await saved(journal)) as Plan | undefined;
  if (pending && pending.database !== database) conflict(journal);
  let published = !!pending;
  async function publish(plan: Plan) {
    if (!stateInfo) await mkdir(state, { recursive: true });
    await atomicJson(journal, plan);
    published = true;
  }
  async function finish(locks: LayoutLocks) {
    await locks.release();
    if (published) {
      await rm(journal, { force: true });
      await rm(cursor, { force: true });
    }
  }
  if (pending?.planning || pending?.committed) {
    const locks = new LayoutLocks(
      root,
      pending.id,
      pending.locks,
      async () => {},
    );
    await finish(locks);
    if (pending.committed) return [];
    pending = undefined;
    published = false;
  }
  const draft: Plan = {
    id: pending?.id ?? randomUUID(),
    database,
    locks: [],
    planning: true,
    steps: [],
    globals: [],
    origins: [],
  };
  const locks = new LayoutLocks(root, draft.id, pending?.locks ?? [], (paths) =>
    publish({ ...draft, locks: paths }),
  );
  const skipped = new Set<string>();
  const warnings: string[] = [];
  let plan = pending;
  // Preflight the same namespace across scopes together so a blocked source never
  // leaves a relocated grant pointing at the wrong installation.
  while (!plan) {
    try {
      plan = await planLayouts(root, catalogs, skipped, locks);
    } catch (error) {
      if (!(error instanceof BlockedGroup) || skipped.has(error.group))
        throw error;
      skipped.add(error.group);
      warnings.push(error.message);
    }
  }
  if (!plan.steps.length) {
    await finish(locks);
    return warnings;
  }
  if (!pending) {
    plan.database = database;
    plan.locks = [...locks.paths];
    await publish(plan);
  }
  await locks.restore();
  const progress = await saved(cursor);
  const start = progress?.id === plan.id ? progress.next : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > plan.steps.length)
    conflict(cursor);
  for (let index = start; index < plan.steps.length; index++) {
    await applyLayoutStep(root, plan.steps[index]);
    await atomicJson(cursor, { id: plan.id, next: index + 1 });
  }
  for (const { store, target, moves } of plan.origins)
    await migrateSkillOriginUnits(
      root,
      target,
      join(root, store),
      new Map(moves),
    );
  if (plan.globals.length) {
    if (!onGlobalPaths) conflict(journal);
    await onGlobalPaths(new Map(plan.globals), plan.id);
  }
  plan.committed = true;
  await publish(plan);
  await finish(locks);
  return warnings;
}
