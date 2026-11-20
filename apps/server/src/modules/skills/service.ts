import { enabledPluginSkills } from '../plugins/skill-access.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  validateSkillContent,
  validateSkillMetadata,
} from '@mastra/core/skills';
import type {
  InstalledSkill,
  InstalledSkills,
  RepositorySkill,
  SkillScan,
  SkillContent,
  SkillDestination,
} from '@aime/shared/skills';
import {
  projectWorkspaceSchema,
  type ProjectWorkspace,
} from '@aime/shared/projects';
import { SkillError } from './errors.js';
import {
  clearPersonalSkillShares,
  listSkillShareLinks,
  projectSharedSkillsRoot,
  readSkillShareLink,
  resolveSkillShareLink,
  withSkillShareLock,
  type SkillShareLink,
} from './share-links.js';
import { readSkillArchive } from './archive.js';
import {
  readSkillProject,
  readSkillArchiveGroup,
  SKILL_ARCHIVE_FILE,
  pruneSkillArchiveGroup,
  SKILL_META_DIRECTORY,
  SKILL_PROJECT_FILE,
  skillProjectSchema,
  type SkillProject,
} from './project.js';
import { fileError } from '../files/paths.js';
import {
  createProjectFilesystem,
  projectDirectory,
  userDirectory,
} from '../threads/workspace.js';
import {
  assertTransferTree,
  moveSkillDirectory,
  pruneEmptySkillParents,
  type SkillTransferOptions,
} from './transfer.js';
import type { EnvironmentVariableService } from '../environment-variables/service.js';
import {
  normalizeSkillSource,
  readSkillSources,
  serializeSkillSources,
  SKILL_SOURCES_FILE,
  type SkillSource,
} from './sources.js';
import {
  downloadGitHubRepository,
  isRegularFile,
  parseGitHubRepository,
  safeRepositoryPath,
  type GitHubRepository,
  type RepositoryFile,
  type RepositorySnapshot,
} from './github.js';

const SCAN_TTL = 15 * 60_000;
type CachedScan = {
  source?: SkillSource;
  group: string;
  result: SkillScan;
  snapshot: RepositorySnapshot;
  timer: NodeJS.Timeout;
};

export type SkillGroupReplaced = (
  previousDirectory: string,
  previous: InstalledSkill[],
  installedDirectory: string,
  installed: InstalledSkill[],
) => Promise<void>;

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 54)
      .replace(/-$/, '') || 'skill'
  );
}

function describe(content: string, name: string) {
  const parsed = validateSkillContent({ content });
  const validation = parsed.metadata
    ? validateSkillMetadata({
        metadata: { ...parsed.metadata, name },
        instructions: parsed.instructions,
      })
    : parsed;
  return {
    description:
      typeof parsed.metadata?.description === 'string'
        ? parsed.metadata.description
        : '',
    valid: validation.valid,
    errors: validation.errors,
  };
}

function skillFiles(snapshot: RepositorySnapshot, manifest: string) {
  const prefix = manifest === 'SKILL.md' ? '' : `${dirname(manifest)}/`;
  return snapshot.files.filter((file) => file.path.startsWith(prefix));
}

async function stat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function describeInstallation(
  directory: string,
  path: string,
  project: SkillProject | undefined,
  manifest: boolean,
  archive = false,
): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = [];
  const parts = path.split('/');
  if (project) {
    const projectRoot = project.root === '.' ? path : `${path}/${project.root}`;
    for (const entry of project.entries) {
      const metadata = describe(
        await readFile(join(directory, project.root, entry.path), 'utf8'),
        entry.name,
      );
      const entryDirectory = dirname(entry.path);
      skills.push({
        path: `${projectRoot}${entryDirectory === '.' ? '' : `/${entryDirectory}`}`,
        name: entry.name,
        description: metadata.description,
        valid: metadata.valid,
        group: path,
        projectRoot,
        sourceType:
          parts.length === 1 || parts[0] === '@local' ? 'archive' : 'github',
      });
    }
    return skills;
  }
  if (manifest) {
    const name = basename(directory);
    const file = join(directory, 'SKILL.md');
    const metadata = describe(await readFile(file, 'utf8'), name);
    skills.push({
      path,
      name,
      description: metadata.description,
      valid: metadata.valid,
      group: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      ...((archive || parts[0] === '@local') && {
        sourceType: 'archive' as const,
      }),
    });
    return skills;
  }
  return skills;
}

function assertCurrentLayout(skill: InstalledSkill) {
  if (
    skill.path.startsWith('@local/') ||
    (skill.projectRoot && skill.projectRoot !== skill.group)
  )
    throw new SkillError('SKILL_CONFLICT', 409);
}

export class SkillService {
  readonly root: string;
  private scans = new Map<string, CachedScan>();
  private personalServices = new Map<string, SkillService>();
  private projectServices = new Map<string, SkillService>();
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private workspaceRoot: string,
    private download = downloadGitHubRepository,
    private userId?: string,
    private environmentVariables?: Pick<EnvironmentVariableService, 'getEnv'>,
    private projectId?: string,
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    const directory =
      userId !== undefined
        ? userDirectory(this.workspaceRoot, userId)
        : projectId !== undefined
          ? projectDirectory(this.workspaceRoot, projectId)
          : this.workspaceRoot;
    this.root = join(directory, '.agents', 'skills');
  }

  private get isGlobal() {
    return this.userId === undefined && this.projectId === undefined;
  }

  forUser(userId: string): SkillService {
    let service = this.personalServices.get(userId);
    if (!service) {
      service = new SkillService(
        this.workspaceRoot,
        this.download,
        userId,
        this.environmentVariables,
      );
      this.personalServices.set(userId, service);
    }
    return service;
  }

  forProject(projectId: string): SkillService {
    let service = this.projectServices.get(projectId);
    if (!service) {
      service = new SkillService(
        this.workspaceRoot,
        this.download,
        undefined,
        this.environmentVariables,
        projectId,
      );
      this.projectServices.set(projectId, service);
    }
    return service;
  }

  async withProjectWorkspace<T>(
    projectId: string,
    config: ProjectWorkspace,
    action: (service: SkillService) => Promise<T>,
  ): Promise<T> {
    const path = projectDirectory(this.workspaceRoot, projectId);
    const workspace = projectWorkspaceSchema.parse(config);
    const filesystem = createProjectFilesystem(path, workspace);
    await this.checkedDirectory(path, true);
    if (workspace.mode === 'composite')
      for (const name of [
        '.uploads',
        ...workspace.mounts.map((mount) => mount.mountPath),
      ])
        await this.checkedDirectory(join(path, name));
    try {
      await filesystem.init?.();
      return await action(this.forProject(projectId));
    } finally {
      await filesystem.destroy?.();
    }
  }

  private shareRoot(target: SkillDestination) {
    return target.scope === 'global'
      ? resolve(this.workspaceRoot, '.agents', 'skills')
      : projectSharedSkillsRoot(this.workspaceRoot, target.projectId);
  }

  private async linkedEntries(
    target: SkillDestination,
    link: SkillShareLink,
    includeMissing: boolean,
  ) {
    const source = await resolveSkillShareLink(
      this.workspaceRoot,
      this.shareRoot(target),
      link.unit,
    );
    let entries: InstalledSkill[] = [];
    if (source?.userId === link.userId) {
      try {
        entries = await describeInstallation(
          source.directory,
          link.unit,
          source.project,
          !source.project,
          source.archive,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (includeMissing && !entries.length)
      entries = [
        {
          path: link.unit,
          name: basename(link.unit),
          group: dirname(link.unit) === '.' ? '' : dirname(link.unit),
          description: '',
          valid: false,
        },
      ];
    return entries.map((skill) => ({
      ...skill,
      sharing: { ...target, userId: link.userId, userName: link.userId },
    }));
  }

  private async linkedSkills(
    target: SkillDestination,
    userId?: string,
  ): Promise<InstalledSkill[]> {
    const links = await listSkillShareLinks(
      this.workspaceRoot,
      this.shareRoot(target),
      userId,
    );
    const entries = [];
    for (const link of links)
      entries.push(...(await this.linkedEntries(target, link, !!userId)));
    return entries;
  }

  listPersonalShares(userId: string, target: SkillDestination) {
    userDirectory(this.workspaceRoot, userId);
    return this.linkedSkills(target, userId);
  }

  async sharePersonal(
    userId: string,
    path: string,
    target: SkillDestination,
  ): Promise<InstalledSkill[]> {
    if (
      !this.isGlobal ||
      !safeRepositoryPath(path) ||
      (target.scope === 'global' &&
        ['builtin', 'plugins'].includes(path.split('/')[0].toLowerCase()))
    )
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    const personal = this.forUser(userId);
    const destination =
      target.scope === 'global' ? this : this.forProject(target.projectId);
    const store = this.shareRoot(target);
    return personal.exclusive(() =>
      destination.exclusive(() =>
        personal.withGroupLock(path.split('/')[0], async () => {
          const installed = (await personal.list()).skills;
          const selected = installed.find((entry) => entry.path === path);
          if (!selected) throw new SkillError('SKILL_NOT_FOUND', 404);
          assertCurrentLayout(selected);
          const unit = selected.projectRoot ? selected.group : selected.path;
          const entries = selected.projectRoot
            ? installed.filter(
                (entry) => entry.projectRoot === selected.projectRoot,
              )
            : [selected];
          const parts = unit.split('/');
          const source = await personal.directory(parts);
          if (!source) throw new SkillError('SKILL_NOT_FOUND', 404);
          await assertTransferTree(source);
          await this.checkedDirectory(store, true);
          return withSkillShareLock(
            this.workspaceRoot,
            store,
            unit,
            async () => {
              const existing = await readSkillShareLink(
                this.workspaceRoot,
                store,
                unit,
              );
              if (existing?.userId === userId)
                return this.linkedEntries(target, existing, false);
              const names = new Set(entries.map((entry) => entry.name));
              if (
                (await destination.list()).skills.some((entry) =>
                  names.has(entry.name),
                )
              )
                throw new SkillError('SKILL_CONFLICT', 409);
              const archiveGroup =
                selected.sourceType === 'archive' && !selected.projectRoot
                  ? selected.group
                  : undefined;
              await destination.assertImportAncestors(
                parts,
                true,
                archiveGroup,
              );
              if (archiveGroup && target.scope === 'project')
                await destination.archiveContainer(
                  join(destination.root, archiveGroup),
                );
              // Project-local native installs and server-managed links share one catalog.
              if (
                target.scope === 'project' &&
                (await stat(join(destination.root, unit)))
              )
                throw new SkillError('SKILL_CONFLICT', 409);
              const location = join(store, unit);
              const created: string[] = [];
              try {
                if (archiveGroup)
                  await this.archiveContainer(
                    join(store, archiveGroup),
                    true,
                    created,
                  );
                await this.checkedDirectory(dirname(location), true, created);
                await symlink(
                  relative(dirname(location), source),
                  location,
                  'dir',
                ).catch((error: NodeJS.ErrnoException) => {
                  if (error.code === 'EEXIST')
                    throw new SkillError('SKILL_CONFLICT', 409);
                  throw error;
                });
              } catch (error) {
                if (created.length)
                  await pruneEmptySkillParents(
                    created[created.length - 1],
                    dirname(created[0]),
                  );
                throw error;
              }
              return entries.map((skill) => ({
                ...skill,
                sharing: { ...target, userId, userName: userId },
              }));
            },
            { catalog: true },
          );
        }),
      ),
    );
  }

  async unsharePersonal(
    userId: string,
    path: string,
    target: SkillDestination,
  ): Promise<InstalledSkill[]> {
    if (!this.isGlobal || !safeRepositoryPath(path))
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    const destination =
      target.scope === 'global' ? this : this.forProject(target.projectId);
    const store = this.shareRoot(target);
    if (!(await this.checkedDirectory(store)))
      throw new SkillError('SKILL_NOT_FOUND', 404);
    return this.forUser(userId).exclusive(() =>
      destination.exclusive(() =>
        withSkillShareLock(this.workspaceRoot, store, path, async () => {
          let unit = path;
          while (unit !== '.') {
            const link = await readSkillShareLink(
              this.workspaceRoot,
              store,
              unit,
            );
            if (link) {
              if (link.userId !== userId)
                throw new SkillError('FORBIDDEN', 403);
              const entries = await this.linkedEntries(target, link, true);
              if (
                path !== unit &&
                !entries.some((entry) => entry.path === path)
              )
                throw new SkillError('SKILL_NOT_FOUND', 404);
              await unlink(join(store, unit));
              await pruneEmptySkillParents(dirname(join(store, unit)), store);
              return entries.map((skill) => ({ ...skill, sharing: undefined }));
            }
            unit = dirname(unit);
          }
          throw new SkillError('SKILL_NOT_FOUND', 404);
        }),
      ),
    );
  }

  async restoreMovedPersonal(
    userId: string,
    path: string,
    target: SkillDestination,
    options: SkillTransferOptions,
  ): Promise<InstalledSkill[]> {
    if (!this.isGlobal || !safeRepositoryPath(path))
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    const lock = path.split('/')[0];
    if (
      target.scope === 'global' &&
      ['builtin', 'plugins'].includes(lock.toLowerCase())
    )
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    const personal = this.forUser(userId);
    const shared =
      target.scope === 'global' ? this : this.forProject(target.projectId);
    // The CLI installer also serializes on the first path segment.
    return personal.exclusive(() =>
      shared.exclusive(() =>
        personal.withGroupLock(lock, () =>
          shared.withGroupLock(lock, () =>
            shared.transferInstalled(path, personal, options),
          ),
        ),
      ),
    );
  }

  private async transferInstalled(
    path: string,
    destination: SkillService,
    options: SkillTransferOptions,
  ) {
    const installed = (await this.list()).skills;
    const skill = installed.find((entry) => entry.path === path);
    if (!skill) throw new SkillError('SKILL_NOT_FOUND', 404);
    assertCurrentLayout(skill);
    const entries = skill.projectRoot
      ? installed.filter(
          (entry) =>
            entry.group === skill.group &&
            entry.projectRoot === skill.projectRoot,
        )
      : [skill];
    const unit = skill.projectRoot ? skill.group : skill.path;
    const parts = unit.split('/');
    const directory = await this.directory(parts);
    if (!directory) throw new SkillError('SKILL_NOT_FOUND', 404);
    await options.verify(directory, entries);
    const archiveGroup =
      skill.sourceType === 'archive' && !skill.projectRoot
        ? skill.group
        : undefined;
    await destination.assertImportAncestors(parts, true, archiveGroup);
    const names = new Set(entries.map((entry) => entry.name));
    if (
      (await destination.list()).skills.some((entry) => names.has(entry.name))
    )
      throw new SkillError('SKILL_CONFLICT', 409);
    const created: string[] = [];
    try {
      if (archiveGroup)
        await destination.archiveContainer(
          join(destination.root, archiveGroup),
          true,
          created,
        );
      const parent = (await destination.directory(
        parts.slice(0, -1),
        true,
        created,
      ))!;
      const moved = join(parent, parts.at(-1)!);
      await moveSkillDirectory(
        directory,
        moved,
        skill,
        installed.some(
          (entry) => entry.path !== path && entry.group === skill.group,
        ),
        () => options.commit(moved, entries),
      );
    } catch (error) {
      if (created.length)
        await pruneEmptySkillParents(
          created[created.length - 1],
          dirname(created[0]),
        );
      throw error;
    }
    await pruneEmptySkillParents(dirname(directory), this.root);
    return entries;
  }

  private directory(
    parts: string[],
    create = false,
    created?: string[],
  ): Promise<string | null> {
    return this.checkedDirectory(join(this.root, ...parts), create, created);
  }

  private async archiveContainer(
    directory: string,
    create = false,
    created?: string[],
  ) {
    const existing = await this.checkedDirectory(directory);
    if (existing && (await readSkillArchiveGroup(existing))) return;
    if (existing && (await readdir(existing)).length)
      throw new SkillError('SKILL_CONFLICT', 409);
    if (!create) return;
    await this.checkedDirectory(directory, true, created);
    const staging = await mkdtemp(
      join(dirname(directory), '.skill-archive-meta-'),
    );
    try {
      await writeFile(
        join(staging, SKILL_ARCHIVE_FILE),
        JSON.stringify({ version: 1 }),
        { flag: 'wx' },
      );
      await rename(staging, join(directory, SKILL_META_DIRECTORY));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Startup migrates legacy archive containers; unresolved ones must not be duplicated. */
  private async assertArchiveMigrated(group: string) {
    if (await stat(join(this.root, '.@local.skill-install.lock')))
      throw new SkillError('SKILL_CONFLICT', 409);
    const legacyRoot = join(this.root, '@local');
    const root = await stat(legacyRoot);
    if (!root) return;
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new SkillError('SKILL_CONFLICT', 409);
    const directory = join(legacyRoot, group);
    const old = await stat(directory);
    if (
      old &&
      (!old.isDirectory() ||
        old.isSymbolicLink() ||
        (await readdir(directory)).length)
    )
      throw new SkillError('SKILL_CONFLICT', 409);
  }

  /** Check each component, including absent ancestors, before any read/write. */
  private async checkedDirectory(
    directory: string,
    create = false,
    created?: string[],
  ): Promise<string | null> {
    let current = this.workspaceRoot;
    const path = relative(this.workspaceRoot, directory);
    if (
      !path ||
      path === '..' ||
      path.startsWith('..' + sep) ||
      isAbsolute(path)
    )
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    if (create) await mkdir(current, { recursive: true });
    for (const part of path.split(sep)) {
      current = join(current, part);
      if (create) {
        try {
          await mkdir(current);
          created?.push(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const info = await stat(current);
      if (!info) return null;
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
    }
    return current;
  }

  private async assertImportAncestors(
    parts: string[],
    manifests = true,
    archiveGroup?: string,
  ) {
    for (let depth = 0; depth < parts.length; depth++) {
      const directory = await this.directory(parts.slice(0, depth));
      if (!directory) break;
      if (
        (manifests && (await stat(join(directory, 'SKILL.md')))) ||
        (depth > 0 &&
          (await readSkillArchiveGroup(directory)) &&
          parts.slice(0, depth).join('/') !== archiveGroup) ||
        (depth > 0 &&
          depth <= 2 &&
          (await readSkillProject(directory, { legacy: depth === 2 })))
      )
        throw new SkillError('SKILL_CONFLICT', 409);
    }
  }

  async list(): Promise<InstalledSkills> {
    const skills: InstalledSkill[] = [];
    const enabled = this.isGlobal
      ? await enabledPluginSkills(this.workspaceRoot)
      : undefined;
    const visit = async (
      directory: string,
      path: string,
      archiveParent = false,
    ) => {
      const parts = path ? path.split('/') : [];
      if (
        enabled &&
        parts[0] === 'plugins' &&
        parts[1] &&
        !enabled.has(parts[1])
      )
        return;
      const entries = await readdir(directory, { withFileTypes: true });
      const archive =
        archiveParent ||
        (parts.length === 1 && (await readSkillArchiveGroup(directory)));
      const project =
        !archive && (parts.length === 1 || parts.length === 2)
          ? await readSkillProject(directory, { legacy: parts.length === 2 })
          : undefined;
      const installed = await describeInstallation(
        directory,
        path,
        project,
        entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile()),
        archiveParent,
      );
      if (installed.length) {
        skills.push(...installed);
        return;
      }
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.name.startsWith('.')) continue;
        const unit = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory())
          await visit(join(directory, entry.name), unit, archive);
        else if (this.isGlobal && entry.isSymbolicLink()) {
          const link = await readSkillShareLink(
            this.workspaceRoot,
            this.root,
            unit,
          );
          if (link)
            skills.push(
              ...(await this.linkedEntries({ scope: 'global' }, link, false)),
            );
        }
      }
    };
    if (await this.directory([])) await visit(this.root, '');
    if (this.projectId)
      skills.push(
        ...(await this.linkedSkills({
          scope: 'project',
          projectId: this.projectId,
        })),
      );
    return { root: this.root, skills };
  }

  async scan(
    input: string,
    signal?: AbortSignal,
    mode: 'skills' | 'project' = 'skills',
  ): Promise<SkillScan> {
    return this.scanRepository(input, signal, undefined, undefined, mode);
  }

  private async scanRepository(
    input: string,
    signal?: AbortSignal,
    original?: SkillSource,
    legacyPaths?: Set<string>,
    mode: 'skills' | 'project' = 'skills',
    resolveRef = false,
  ): Promise<SkillScan> {
    const repository = parseGitHubRepository(input);
    const snapshot = await this.download(
      repository,
      signal,
      resolveRef ? undefined : original,
      {
        ...process.env,
        ...(await this.environmentVariables?.getEnv(this.userId)),
      },
    );
    return this.scanSnapshot(
      repository,
      snapshot,
      input,
      signal,
      original,
      legacyPaths,
      undefined,
      mode,
    );
  }

  async scanArchive(
    filename: string,
    data: Buffer,
    signal?: AbortSignal,
    mode: 'skills' | 'project' = 'skills',
  ): Promise<SkillScan> {
    const snapshot = await readSkillArchive(filename, data, signal);
    const repo = slug(filename.replace(/\.(zip|skill)$/i, ''));
    try {
      if (mode === 'project') {
        const regular = snapshot.files.filter(isRegularFile);
        const prefix = `${regular[0]?.path.split('/')[0]}/`;
        const installedGroup = await this.directory([repo]);
        const installed = installedGroup
          ? await readSkillProject(installedGroup)
          : undefined;
        const rawPaths = new Set(regular.map((file) => file.path));
        const keepsWrapper = installed?.entries.every((entry) =>
          rawPaths.has(entry.path),
        );
        if (
          !keepsWrapper &&
          regular.length &&
          regular.every((file) => file.path.startsWith(prefix))
        ) {
          if (prefix.slice(0, -1).toLowerCase() === SKILL_META_DIRECTORY)
            throw new SkillError('SKILL_CONFLICT', 409);
          // Archive resources use immutable oids for I/O; only their project-relative paths change.
          snapshot.files = snapshot.files.map((file) => ({
            ...file,
            path: file.path.slice(prefix.length),
          }));
          snapshot.directories = snapshot.directories
            ?.filter((path) => path.startsWith(prefix))
            .map((path) => path.slice(prefix.length))
            .filter(Boolean);
        }
      }
    } catch (error) {
      await snapshot.dispose();
      throw error;
    }
    return this.scanSnapshot(
      {
        owner: '',
        repo,
        url: '',
      },
      snapshot,
      undefined,
      signal,
      undefined,
      undefined,
      filename,
      mode,
    );
  }

  private async scanSnapshot(
    repository: GitHubRepository,
    snapshot: RepositorySnapshot,
    input?: string,
    signal?: AbortSignal,
    original?: SkillSource,
    legacyPaths?: Set<string>,
    filename?: string,
    mode: 'skills' | 'project' = 'skills',
  ): Promise<SkillScan> {
    try {
      if (signal?.aborted) throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
      const projectMode =
        mode === 'project' || original?.installation?.mode === 'project';
      const group = filename
        ? repository.repo
        : `${repository.owner}/${repository.repo}`;
      if (filename) await this.assertArchiveMigrated(group);
      if (
        this.isGlobal &&
        (projectMode || filename) &&
        ['plugins', 'builtin'].includes(group)
      )
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      const parent = await this.directory(group.split('/'));
      await this.assertImportAncestors(group.split('/'), false);
      if (
        projectMode &&
        [
          ...snapshot.files.map((file) => file.path),
          ...(snapshot.directories ?? []),
        ].some((path) => {
          const top = path.split('/')[0].toLowerCase();
          return top === SKILL_META_DIRECTORY;
        })
      )
        throw new SkillError('SKILL_CONFLICT', 409);
      if (
        filename &&
        !projectMode &&
        parent &&
        !(await readSkillArchiveGroup(parent)) &&
        (await readdir(parent)).length
      )
        throw new SkillError('SKILL_CONFLICT', 409);
      if (
        !projectMode &&
        parent &&
        (await readSkillProject(parent, {
          legacy: group.split('/').length === 2,
        }))
      )
        throw new SkillError('SKILL_CONFLICT', 409);
      // Resolve names across the whole repository so scoped and full scans use identical destinations.
      const manifests = snapshot.files.filter(
        (file) => isRegularFile(file) && /(^|\/)SKILL\.md$/.test(file.path),
      );
      const candidates = [];
      for (const file of manifests) {
        if (signal?.aborted) throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
        const content = (await snapshot.read(file)).toString('utf8');
        const parsed = validateSkillContent({ content });
        const name = slug(
          file.path === 'SKILL.md'
            ? typeof parsed.metadata?.name === 'string'
              ? parsed.metadata.name
              : repository.repo
            : basename(dirname(file.path)),
        );
        candidates.push({ file, content, name });
      }
      const counts = new Map<string, number>();
      for (const candidate of candidates)
        counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
      const named = candidates.map((candidate) => ({
        ...candidate,
        name:
          counts.get(candidate.name)! > 1
            ? `${candidate.name}-${createHash('sha256').update(candidate.file.path).digest('hex').slice(0, 8)}`
            : candidate.name,
      }));
      if (projectMode) {
        const manifests = new Set(named.map(({ file }) => file.path));
        const roots = named.filter(({ file }) => {
          let parent = dirname(file.path);
          while (parent !== '.') {
            parent = dirname(parent);
            if (
              manifests.has(parent === '.' ? 'SKILL.md' : `${parent}/SKILL.md`)
            )
              return false;
          }
          return true;
        });
        const previous =
          original?.installation?.mode === 'project'
            ? original.installation.entries
            : undefined;
        const enabled = previous
          ? previous.map((entry) => {
              const candidate = roots.find(
                ({ file }) => file.path === entry.path,
              );
              if (!candidate)
                throw new SkillError('SKILL_UPDATE_SOURCE_NOT_FOUND', 409);
              return { ...candidate, name: entry.name };
            })
          : roots;
        const regular = snapshot.files.filter(isRegularFile);
        const skills = enabled.map(
          ({ file, content, name }): RepositorySkill => {
            const metadata = describe(content, name);
            if (previous && !metadata.valid)
              throw new SkillError('SKILL_UPDATE_EMPTY', 409);
            const files = skillFiles(snapshot, file.path);
            const resources = files.filter(isRegularFile);
            const folder = dirname(file.path);
            return {
              path: file.path,
              group: folder === '.' ? '' : dirname(folder).replace(/^\.$/, ''),
              name,
              ...metadata,
              destination: `${group}${folder === '.' ? '' : `/${folder}`}`,
              installed: !!parent,
              fileCount: resources.length,
              bytes: resources.reduce((size, entry) => size + entry.size, 0),
              skippedFiles: files.length - resources.length,
              bundledSkills: resources
                .filter(
                  (entry) =>
                    entry.path !== file.path &&
                    /(^|\/)SKILL\.md$/.test(entry.path),
                )
                .map((entry) => entry.path),
            };
          },
        );
        const result: SkillScan = {
          id: randomUUID(),
          ...repository,
          importMode: 'project',
          ...(filename ? { sourceType: 'archive' as const, filename } : {}),
          project: {
            destination: group,
            fileCount: regular.length,
            bytes: regular.reduce((size, entry) => size + entry.size, 0),
            skippedFiles: snapshot.files.length - regular.length,
          },
          commit: snapshot.commit,
          scope: '',
          ref: snapshot.ref ?? null,
          expiresAt: new Date(Date.now() + SCAN_TTL).toISOString(),
          skills,
        };
        if (signal?.aborted) throw new SkillError('ABORTED');
        const timer = setTimeout(() => {
          void this.discard(result.id).catch(() => {});
        }, SCAN_TTL);
        timer.unref();
        this.scans.set(result.id, {
          result,
          snapshot,
          timer,
          group,
          source: input
            ? {
                url: repository.url,
                ref: snapshot.ref ?? null,
                scope: '',
                installation: {
                  mode: 'project',
                  entries: skills
                    .filter((skill) => skill.valid)
                    .map((skill) => ({ path: skill.path, name: skill.name })),
                },
              }
            : undefined,
        });
        return result;
      }
      const { scopePath, fileOnly } = snapshot;
      const scoped = named.filter(
        ({ file }) =>
          !scopePath ||
          (fileOnly
            ? file.path === scopePath
            : file.path.startsWith(`${scopePath}/`)),
      );
      const entryPath = snapshot.fileOnly
        ? snapshot.scopePath!
        : snapshot.scopePath
          ? `${snapshot.scopePath}/SKILL.md`
          : 'SKILL.md';
      const entry = scoped.find(({ file }) => file.path === entryPath);
      // The previous Python installer used the repository name for root packages.
      const legacyName = [
        ...(entry ? [entry.name] : []),
        ...(entryPath === 'SKILL.md' ? [slug(repository.repo)] : []),
      ].find((name) => legacyPaths?.has(`${group}/${name}`));
      const installation =
        original?.installation ??
        (legacyName || (entry && !legacyPaths)
          ? {
              mode: 'package' as const,
              path: entryPath,
              name: legacyName ?? entry!.name,
            }
          : { mode: 'collection' as const });
      let selected = scoped;
      if (installation.mode === 'package') {
        const entry = scoped.find(
          ({ file }) => file.path === installation.path,
        );
        if (!entry) throw new SkillError('SKILL_UPDATE_SOURCE_NOT_FOUND', 409);
        selected = [{ ...entry, name: installation.name }];
      } else {
        // A collection remains a collection even if upstream later adds a root manifest.
        const children = scoped.filter(({ file }) => file.path !== entryPath);
        const manifests = new Set(children.map(({ file }) => file.path));
        selected = children.filter(({ file }) => {
          let parent = dirname(dirname(file.path));
          while (parent !== '.') {
            if (manifests.has(`${parent}/SKILL.md`)) return false;
            parent = dirname(parent);
          }
          return true;
        });
      }
      const skills: RepositorySkill[] = [];
      for (const { file, content, name } of selected) {
        const files = skillFiles(snapshot, file.path);
        const regular = files.filter(isRegularFile);
        const metadata = describe(content, name);
        const bundledSkills = regular
          .filter(
            (entry) =>
              entry.path !== file.path && /(^|\/)SKILL\.md$/.test(entry.path),
          )
          .map((entry) => entry.path);
        const destination = `${group}/${name}`;
        skills.push({
          path: file.path,
          group:
            file.path === 'SKILL.md'
              ? ''
              : dirname(dirname(file.path)).replace(/^\.$/, ''),
          name,
          ...metadata,
          destination,
          installed: !!(parent && (await stat(join(parent, name)))),
          fileCount: regular.length,
          bytes: regular.reduce((total, entry) => total + entry.size, 0),
          skippedFiles: files.length - regular.length,
          package: installation.mode === 'package' || bundledSkills.length > 0,
          bundledSkills,
        });
      }
      const result: SkillScan = {
        id: randomUUID(),
        ...repository,
        ...(filename ? { sourceType: 'archive' as const, filename } : {}),
        commit: snapshot.commit,
        scope: snapshot.scopePath ?? '',
        ref: snapshot.ref ?? null,
        expiresAt: new Date(Date.now() + SCAN_TTL).toISOString(),
        skills,
      };
      if (signal?.aborted) throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
      const timer = setTimeout(() => {
        void this.discard(result.id).catch(() => {});
      }, SCAN_TTL);
      timer.unref();
      this.scans.set(result.id, {
        result,
        snapshot,
        timer,
        group,
        source: input
          ? {
              url: normalizeSkillSource(input),
              ref: snapshot.ref ?? null,
              scope: snapshot.scopePath ?? '',
              installation,
            }
          : undefined,
      });
      return result;
    } catch (error) {
      await snapshot?.dispose();
      throw error;
    }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(action);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  discard(id: string) {
    return this.exclusive(() => this.releaseScan(id));
  }

  private async releaseScan(id: string) {
    const scan = this.scans.get(id);
    if (!scan) return;
    this.scans.delete(id);
    clearTimeout(scan.timer);
    await scan.snapshot.dispose();
  }

  install(id: string, paths: string[]): Promise<InstalledSkill[]> {
    return this.exclusive(async () => {
      let scan: CachedScan;
      try {
        // Reject stale scans and invalid selections before creating the lock directory.
        scan = this.selection(id, paths).cached;
      } catch (error) {
        await this.releaseScan(id);
        throw error;
      }
      return this.withGroupLock(scan.group, () => this.installScan(id, paths));
    });
  }

  private selection(id: string, paths: string[]) {
    const cached = this.scans.get(id);
    if (!cached || Date.parse(cached.result.expiresAt) <= Date.now())
      throw new SkillError('SKILL_SCAN_EXPIRED', 410);
    const selected = [...new Set(paths)].map((path) => {
      const skill = cached.result.skills.find((skill) => skill.path === path);
      if (!skill || !skill.valid)
        throw new SkillError('SKILL_INVALID_SELECTION');
      return skill;
    });
    if (!selected.length) throw new SkillError('SKILL_INVALID_SELECTION');
    return { cached, selected };
  }

  private async withGroupLock<T>(
    group: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const parts = group.split('/');
    if (this.isGlobal && parts[0] === 'plugins')
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    if (parts.length > 2 || !safeRepositoryPath(group)) return action();
    const locks: string[] = [];
    try {
      for (let depth = 0; depth < parts.length; depth++) {
        // Holding each parent lock prevents a single-directory archive project from
        // being published while a GitHub owner directory is being created beneath it.
        await this.assertImportAncestors(parts.slice(0, depth + 1));
        const parent = (await this.directory(parts.slice(0, depth), true))!;
        const lock = join(parent, `.${parts[depth]}.skill-install.lock`);
        await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST')
            throw new SkillError('SKILL_CONFLICT', 409);
          throw error;
        });
        locks.push(lock);
      }
      return await action();
    } finally {
      for (const lock of locks.reverse()) await rmdir(lock);
    }
  }

  private async installScan(
    id: string,
    paths: string[],
  ): Promise<InstalledSkill[]> {
    try {
      const { cached, selected } = this.selection(id, paths);
      const { owner, repo } = cached.result;
      if (cached.result.sourceType === 'archive')
        await this.assertArchiveMigrated(cached.group);
      if (this.isGlobal && owner === 'plugins')
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      if (cached.result.importMode === 'project')
        return await this.installProject(cached, selected);
      if (cached.result.sourceType === 'archive')
        return await this.installArchiveSkills(cached, selected);
      await this.assertImportAncestors([owner, repo]);
      const existingGroup = await this.directory([owner, repo]);
      if (
        existingGroup &&
        (await readSkillProject(existingGroup, { legacy: true }))
      )
        throw new SkillError('SKILL_CONFLICT', 409);
      // An existing manifest on an ancestor would hide all installed children at runtime.
      for (const parts of [[], [owner], [owner, repo]]) {
        const parent = await this.directory(parts, true);
        if (await stat(join(parent!, 'SKILL.md')))
          throw new SkillError('SKILL_CONFLICT', 409);
      }
      const parent = (await this.directory([owner, repo], true))!;
      const sources = cached.source ? await readSkillSources(parent) : [];
      for (const skill of selected) {
        if (await stat(join(parent, skill.name)))
          throw new SkillError('SKILL_CONFLICT', 409);
      }
      const staging = await mkdtemp(
        join(dirname(this.root), '.skill-install-'),
      );
      const installed: string[] = [];
      try {
        if (cached.source)
          await writeFile(
            join(staging, SKILL_SOURCES_FILE),
            serializeSkillSources([...sources, cached.source]),
            { flag: 'wx' },
          );
        for (const skill of selected) {
          const target = join(staging, skill.name);
          await mkdir(target);
          const prefix =
            skill.path === 'SKILL.md' ? '' : `${dirname(skill.path)}/`;
          for (const file of skillFiles(cached.snapshot, skill.path).filter(
            isRegularFile,
          )) {
            await this.writeResource(
              target,
              file.path.slice(prefix.length),
              file,
              cached.snapshot,
            );
          }
        }
        for (const skill of selected) {
          await this.directory([owner, repo]);
          const target = join(parent, skill.name);
          if (await stat(target)) throw new SkillError('SKILL_CONFLICT', 409);
          await rename(join(staging, skill.name), target);
          installed.push(target);
        }
        if (cached.source)
          await rename(
            join(staging, SKILL_SOURCES_FILE),
            join(parent, SKILL_SOURCES_FILE),
          );
      } catch (error) {
        await Promise.all(
          installed.map((path) => rm(path, { recursive: true, force: true })),
        );
        throw error;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return selected.map((skill) => ({
        path: skill.destination,
        name: skill.name,
        description: skill.description,
        valid: true,
        group: `${owner}/${repo}`,
      }));
    } finally {
      await this.releaseScan(id);
    }
  }

  private async installArchiveSkills(
    cached: CachedScan,
    selected: RepositorySkill[],
  ): Promise<InstalledSkill[]> {
    const group = cached.group;
    if (this.isGlobal && ['builtin', 'plugins'].includes(group))
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    await this.assertImportAncestors([group]);
    const current = await this.directory([group]);
    const existing = !!current && (await readSkillArchiveGroup(current));
    if (current && !existing && (await readdir(current)).length)
      throw new SkillError('SKILL_CONFLICT', 409);
    const destination = join(this.root, group);
    for (const skill of selected)
      if (await stat(join(destination, skill.name)))
        throw new SkillError('SKILL_CONFLICT', 409);
    const staging = await mkdtemp(
      join(dirname(this.root), '.skill-archive-install-'),
    );
    const installed: string[] = [];
    let removedEmpty = false;
    try {
      for (const skill of selected) {
        const target = join(staging, skill.name);
        await mkdir(target);
        const prefix =
          skill.path === 'SKILL.md' ? '' : `${dirname(skill.path)}/`;
        for (const file of skillFiles(cached.snapshot, skill.path).filter(
          isRegularFile,
        ))
          await this.writeResource(
            target,
            file.path.slice(prefix.length),
            file,
            cached.snapshot,
          );
      }
      if (!existing) {
        await mkdir(join(staging, SKILL_META_DIRECTORY));
        await writeFile(
          join(staging, SKILL_META_DIRECTORY, SKILL_ARCHIVE_FILE),
          JSON.stringify({ version: 1 }),
          { flag: 'wx' },
        );
        if (current) {
          await rmdir(current);
          removedEmpty = true;
        }
        if (await stat(destination))
          throw new SkillError('SKILL_CONFLICT', 409);
        await rename(staging, destination);
        removedEmpty = false;
      } else {
        for (const skill of selected) {
          const target = join(destination, skill.name);
          if (await stat(target)) throw new SkillError('SKILL_CONFLICT', 409);
          await rename(join(staging, skill.name), target);
          installed.push(target);
        }
      }
    } catch (error) {
      for (const path of installed)
        await rm(path, { recursive: true, force: true });
      if (removedEmpty && !(await stat(destination))) await mkdir(destination);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return selected.map((skill) => ({
      path: skill.destination,
      name: skill.name,
      description: skill.description,
      valid: true,
      group,
      sourceType: 'archive',
    }));
  }

  private async installProject(
    cached: CachedScan,
    selected: RepositorySkill[],
  ): Promise<InstalledSkill[]> {
    const groupPath = cached.group;
    const parts = groupPath.split('/');
    if (this.isGlobal && ['plugins', 'builtin'].includes(groupPath))
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    await this.assertImportAncestors(parts);
    const parentDirectory = (await this.directory(parts.slice(0, -1), true))!;
    const destination = join(parentDirectory, parts.at(-1)!);
    if (await stat(destination)) throw new SkillError('SKILL_CONFLICT', 409);
    const project: SkillProject = skillProjectSchema.parse({
      version: 2,
      root: '.',
      entries: selected.map((skill) => ({
        path: skill.path,
        name: skill.name,
      })),
    });
    const staging = await mkdtemp(
      join(dirname(this.root), '.skill-project-install-'),
    );
    try {
      const group = join(staging, 'group');
      await mkdir(group);
      for (const file of cached.snapshot.files.filter(isRegularFile))
        await this.writeResource(group, file.path, file, cached.snapshot);
      const metadata = join(group, SKILL_META_DIRECTORY);
      await mkdir(metadata, { recursive: true });
      await writeFile(
        join(metadata, SKILL_PROJECT_FILE),
        JSON.stringify(project, null, 2),
        { flag: 'wx' },
      );
      if (cached.source) {
        const source: SkillSource = {
          ...cached.source,
          scope: '',
          installation: { mode: 'project', entries: project.entries },
        };
        await writeFile(
          join(metadata, SKILL_SOURCES_FILE),
          serializeSkillSources([source]),
          { flag: 'wx' },
        );
      }
      await this.assertImportAncestors(parts);
      if (await stat(destination)) throw new SkillError('SKILL_CONFLICT', 409);
      await rename(group, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return selected.map((skill) => ({
      path: skill.destination,
      name: skill.name,
      description: skill.description,
      valid: true,
      group: groupPath,
      projectRoot: groupPath,
      sourceType: cached.result.sourceType === 'archive' ? 'archive' : 'github',
    }));
  }

  /** Resolve an installed package under this user's scope and serialize against updates/removal. */
  withFiles<T>(
    path: string,
    action: (root: string, skill: InstalledSkill) => Promise<T>,
    mode: 'read' | 'write' = 'read',
  ): Promise<T> {
    return this.exclusive(async () => {
      if (path && !safeRepositoryPath(path))
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      const skill = (await this.list()).skills.find(
        (entry) => entry.path === path,
      );
      if (!skill) {
        // Preserve the unsafe-path result for untrusted symlinks.
        await this.directory(path ? path.split('/') : []);
        throw new SkillError('SKILL_NOT_FOUND', 404);
      }
      let directory: string | null;
      if (skill.sharing) {
        if (mode === 'write')
          throw new SkillError('SKILL_SHARED_READ_ONLY', 403);
        const unit = skill.projectRoot ? skill.group : skill.path;
        const link = await resolveSkillShareLink(
          this.workspaceRoot,
          this.shareRoot(skill.sharing),
          unit,
        );
        if (!link || link.userId !== skill.sharing.userId)
          throw new SkillError('SKILL_NOT_FOUND', 404);
        directory = await this.checkedDirectory(
          join(link.directory, relative(unit, path)),
        );
        if (directory) await assertTransferTree(directory);
      } else {
        directory = await this.directory(path ? path.split('/') : []);
      }
      if (!directory) throw new SkillError('SKILL_NOT_FOUND', 404);
      try {
        return await action(directory, skill);
      } catch (error) {
        fileError(error);
      }
    });
  }

  read(path: string): Promise<SkillContent> {
    return this.withFiles(path, async (directory, skill) => {
      const manifest = join(directory, 'SKILL.md');
      const info = await stat(manifest);
      if (!info?.isFile() || info.isSymbolicLink())
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      return { skill, content: await readFile(manifest, 'utf8') };
    });
  }

  private async assertGroupWritable(group: string) {
    if (this.userId) return;
    const store = this.projectId
      ? projectSharedSkillsRoot(this.workspaceRoot, this.projectId)
      : this.root;
    if (
      (await listSkillShareLinks(this.workspaceRoot, store)).some(
        ({ unit }) => unit === group || unit.startsWith(group + '/'),
      )
    )
      throw new SkillError('SKILL_SHARED_READ_ONLY', 403);
  }

  updateGroup(
    group: string,
    source?: string,
    afterReplace?: SkillGroupReplaced,
  ): Promise<InstalledSkill[]> {
    return this.exclusive(() =>
      this.withGroupLock(group, async () => {
        if (this.isGlobal && group.split('/')[0] === 'plugins')
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
        if (!safeRepositoryPath(group))
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
        await this.assertGroupWritable(group);
        const directory = await this.directory(group.split('/'));
        const current = (await this.list()).skills.filter(
          (skill) => skill.group === group,
        );
        if (!directory || !current.length)
          throw new SkillError('SKILL_NOT_FOUND', 404);
        const depth = group.split('/').length;
        const project =
          depth <= 2
            ? await readSkillProject(directory, { legacy: depth === 2 })
            : undefined;
        if (await readSkillArchiveGroup(directory))
          throw new SkillError('SKILL_SOURCE_UNKNOWN', 409);
        if (project?.version === 1) throw new SkillError('SKILL_CONFLICT', 409);
        if (project)
          return this.updateProject(
            group,
            directory,
            project,
            current,
            source,
            afterReplace,
          );
        const sources: (string | SkillSource)[] = source
          ? [normalizeSkillSource(source, group)]
          : await readSkillSources(directory);
        for (const source of sources)
          normalizeSkillSource(
            typeof source === 'string' ? source : source.url,
            group,
          );
        if (!sources.length) throw new SkillError('SKILL_SOURCE_UNKNOWN', 409);
        const scans: SkillScan[] = [];
        let staging: string | undefined;
        let backup: string | undefined;
        try {
          // Validate every original scope against the latest upstream snapshot before replacing anything.
          for (const source of sources) {
            let scan: SkillScan;
            try {
              scan = await this.scanRepository(
                typeof source === 'string' ? source : source.url,
                undefined,
                typeof source === 'string' ? undefined : source,
                new Set(current.map((skill) => skill.path)),
              );
            } catch (error) {
              if (
                error instanceof SkillError &&
                error.code === 'SKILL_SOURCE_NOT_FOUND'
              )
                throw new SkillError('SKILL_UPDATE_SOURCE_NOT_FOUND', 409);
              throw error;
            }
            scans.push(scan);
            if (!scan.skills.some((skill) => skill.valid))
              throw new SkillError('SKILL_UPDATE_EMPTY', 409);
          }
          const selected = new Map<string, { scanId: string; path: string }>();
          for (const scan of scans)
            for (const skill of scan.skills.filter((skill) => skill.valid))
              selected.set(skill.destination, {
                scanId: scan.id,
                path: skill.path,
              });
          staging = await mkdtemp(join(dirname(this.root), '.skill-update-'));
          const resolvedSources = scans.map(
            (scan) => this.scans.get(scan.id)!.source!,
          );
          const saved = join(staging, 'previous');
          await rename(directory, saved);
          backup = saved;
          const installed: InstalledSkill[] = [];
          for (const scan of scans) {
            const paths = [...selected.values()]
              .filter((skill) => skill.scanId === scan.id)
              .map((skill) => skill.path);
            if (paths.length)
              installed.push(...(await this.installScan(scan.id, paths)));
          }
          const metadata = join(staging, SKILL_SOURCES_FILE);
          await writeFile(metadata, serializeSkillSources(resolvedSources), {
            flag: 'wx',
          });
          await rename(metadata, join(directory, SKILL_SOURCES_FILE));
          if (this.userId) {
            const next = new Set(installed.map((entry) => entry.path));
            const removed = current
              .filter((entry) => !next.has(entry.path))
              .map((entry) => entry.path);
            if (removed.length)
              await clearPersonalSkillShares(
                this.workspaceRoot,
                this.userId,
                removed,
              );
          }
          await afterReplace?.(saved, current, directory, installed);
          backup = undefined;
          return installed;
        } catch (error) {
          if (backup) {
            await rm(directory, { recursive: true, force: true });
            await rename(backup, directory);
            backup = undefined;
          }
          throw error;
        } finally {
          try {
            await Promise.all(scans.map((scan) => this.releaseScan(scan.id)));
          } finally {
            if (staging && !backup)
              await rm(staging, { recursive: true, force: true });
          }
        }
      }),
    );
  }

  private async updateProject(
    group: string,
    directory: string,
    project: SkillProject,
    current: InstalledSkill[],
    input?: string,
    afterReplace?: SkillGroupReplaced,
  ): Promise<InstalledSkill[]> {
    const sources = await readSkillSources(directory);
    if (sources.length !== 1 || sources[0].installation?.mode !== 'project')
      throw new SkillError('SKILL_SOURCE_UNKNOWN', 409);
    const previous = sources[0];
    const url = input
      ? normalizeSkillSource(input, group)
      : normalizeSkillSource(previous.url, group);
    // The saved entry set is independent from the repository's current manifests.
    const original: SkillSource = {
      ...previous,
      url,
      scope: '',
      installation: { mode: 'project', entries: project.entries },
    };
    let scan: SkillScan;
    try {
      scan = await this.scanRepository(
        url,
        undefined,
        original,
        undefined,
        'project',
        !!input,
      );
    } catch (error) {
      if (
        error instanceof SkillError &&
        error.code === 'SKILL_SOURCE_NOT_FOUND'
      )
        throw new SkillError('SKILL_UPDATE_SOURCE_NOT_FOUND', 409);
      throw error;
    }
    let staging: string | undefined;
    let backup: string | undefined;
    try {
      if (!scan.skills.length || scan.skills.some((skill) => !skill.valid))
        throw new SkillError('SKILL_UPDATE_EMPTY', 409);
      staging = await mkdtemp(
        join(dirname(this.root), '.skill-project-update-'),
      );
      const saved = join(staging, 'previous');
      await rename(directory, saved);
      backup = saved;
      const installed = await this.installScan(
        scan.id,
        scan.skills.map((skill) => skill.path),
      );
      await afterReplace?.(saved, current, directory, installed);
      backup = undefined;
      return installed;
    } catch (error) {
      if (backup) {
        await rm(directory, { recursive: true, force: true });
        await rename(backup, directory);
        backup = undefined;
      }
      throw error;
    } finally {
      await this.releaseScan(scan.id);
      if (staging && !backup)
        await rm(staging, { recursive: true, force: true });
    }
  }

  private async writeResource(
    target: string,
    path: string,
    file: RepositoryFile,
    snapshot: RepositorySnapshot,
  ) {
    if (!safeRepositoryPath(path))
      throw new SkillError('SKILL_UNSAFE_REPOSITORY');
    const output = join(target, path);
    await mkdir(dirname(output), { recursive: true });
    if (snapshot.write) await snapshot.write(file, output);
    else
      await writeFile(output, await snapshot.read(file), {
        flag: 'wx',
        mode: file.mode === '100755' ? 0o755 : 0o644,
      });
  }

  async remove(path: string) {
    if (
      !safeRepositoryPath(path) ||
      (this.isGlobal && path.split('/')[0] === 'plugins')
    )
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    if (!(await this.directory([])))
      throw new SkillError('SKILL_NOT_FOUND', 404);
    return this.exclusive(() =>
      this.withGroupLock(path.split('/')[0], async () => {
        const visible = (await this.list()).skills;
        if (visible.some((entry) => entry.path === path && entry.sharing))
          throw new SkillError('SKILL_SHARED_READ_ONLY', 403);
        const target = await this.directory(path.split('/'));
        const selected = visible.find((skill) => skill.path === path);
        if (!target || !selected) throw new SkillError('SKILL_NOT_FOUND', 404);
        if (selected.projectRoot)
          throw new SkillError('SKILL_PROJECT_MANAGED', 409);
        if (this.userId)
          await clearPersonalSkillShares(this.workspaceRoot, this.userId, [
            path,
          ]);
        await rm(target, { recursive: true });
        const group = path.includes('/')
          ? path.slice(0, path.lastIndexOf('/'))
          : '';
        if (!(await this.list()).skills.some((skill) => skill.group === group))
          await rm(join(dirname(target), SKILL_SOURCES_FILE), { force: true });
        if (selected.sourceType === 'archive')
          await pruneEmptySkillParents(dirname(target), this.root);
      }),
    );
  }

  removeGroup(group: string, expectedPaths: string[]) {
    return this.exclusive(() =>
      this.withGroupLock(group, async () => {
        if (this.isGlobal && group.split('/')[0] === 'plugins')
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
        if (!safeRepositoryPath(group))
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
        await this.assertGroupWritable(group);
        const groupDirectory = await this.directory(group.split('/'));
        if (!groupDirectory) throw new SkillError('SKILL_NOT_FOUND', 404);
        const skills = (await this.list()).skills.filter(
          (skill) => skill.group === group,
        );
        if (!skills.length) throw new SkillError('SKILL_NOT_FOUND', 404);
        const expected = new Set(expectedPaths);
        // Require the exact group that was presented in the confirmation dialog.
        if (
          expected.size !== skills.length ||
          skills.some((skill) => !expected.has(skill.path))
        )
          throw new SkillError('SKILL_GROUP_CHANGED', 409);
        if (skills.some((skill) => skill.projectRoot)) {
          const project = await readSkillProject(groupDirectory, {
            legacy: group.split('/').length === 2,
          });
          if (!project) throw new SkillError('SKILL_PROJECT_INVALID', 409);
          if (this.userId)
            await clearPersonalSkillShares(this.workspaceRoot, this.userId, [
              group,
            ]);
          const staging = await mkdtemp(
            join(dirname(this.root), '.skill-project-remove-'),
          );
          try {
            await rename(groupDirectory, join(staging, 'project'));
          } catch (error) {
            await rm(staging, { recursive: true, force: true });
            throw error;
          }
          await rm(staging, { recursive: true, force: true });
          return skills.map((skill) => skill.path);
        }
        const targets: { path: string; directory: string }[] = [];
        for (const skill of skills) {
          const directory = await this.directory(skill.path.split('/'));
          if (!directory) throw new SkillError('SKILL_GROUP_CHANGED', 409);
          targets.push({ path: skill.path, directory });
        }
        if (this.userId)
          await clearPersonalSkillShares(
            this.workspaceRoot,
            this.userId,
            skills.map((entry) => entry.path),
          );
        // Only remove the skills shown in this group, not sibling groups or loose files.
        const staging = await mkdtemp(
          join(dirname(this.root), '.skill-remove-'),
        );
        const moved: { original: string; staged: string }[] = [];
        try {
          for (const target of targets) {
            const staged = join(staging, basename(target.directory));
            await rename(target.directory, staged);
            moved.push({ original: target.directory, staged });
          }
        } catch (error) {
          for (const entry of moved.reverse())
            await rename(entry.staged, entry.original);
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        await rm(staging, { recursive: true, force: true });
        await rm(join(groupDirectory, SKILL_SOURCES_FILE), { force: true });
        if (await pruneSkillArchiveGroup(groupDirectory))
          return targets.map((target) => target.path);
        // Prune an empty group while preserving separate subgroups or loose files.
        await rmdir(groupDirectory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT')
            throw error;
        });
        return targets.map((target) => target.path);
      }),
    );
  }

  async dispose() {
    await Promise.all([
      ...[...this.scans.keys()].map((id) => this.discard(id)),
      ...[...this.personalServices.values()].map((service) =>
        service.dispose(),
      ),
      ...[...this.projectServices.values()].map((service) => service.dispose()),
    ]);
    this.personalServices.clear();
    this.projectServices.clear();
  }
}
