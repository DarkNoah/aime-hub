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
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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
} from '@aime/shared/skills';
import { SkillError } from './errors.js';
import { readSkillArchive } from './archive.js';
import {
  readSkillProject,
  SKILL_META_DIRECTORY,
  SKILL_PROJECT_FILE,
  skillProjectSchema,
  type SkillProject,
} from './project.js';
import { fileError } from '../files/paths.js';
import { userDirectory } from '../threads/workspace.js';
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
  projectGroup?: string;
  projectVersion?: 1 | 2;
  result: SkillScan;
  snapshot: RepositorySnapshot;
  timer: NodeJS.Timeout;
};

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

export class SkillService {
  readonly root: string;
  private scans = new Map<string, CachedScan>();
  private personalServices = new Map<string, SkillService>();
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private workspaceRoot: string,
    private download = downloadGitHubRepository,
    private userId?: string,
    private environmentVariables?: Pick<EnvironmentVariableService, 'getEnv'>,
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    const directory =
      userId !== undefined
        ? userDirectory(this.workspaceRoot, userId)
        : this.workspaceRoot;
    this.root = join(directory, '.agents', 'skills');
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

  /** Check each component, including absent ancestors, before any read/write. */
  private async directory(
    parts: string[],
    create = false,
  ): Promise<string | null> {
    let current = this.workspaceRoot;
    if (create) await mkdir(current, { recursive: true });
    for (const part of [
      ...(this.userId !== undefined ? ['users', this.userId] : []),
      '.agents',
      'skills',
      ...parts,
    ]) {
      current = join(current, part);
      if (create)
        await mkdir(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const info = await stat(current);
      if (!info) return null;
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
    }
    return current;
  }

  private async assertImportAncestors(parts: string[], manifests = true) {
    for (let depth = 0; depth < parts.length; depth++) {
      const directory = await this.directory(parts.slice(0, depth));
      if (!directory) break;
      if (
        (manifests && (await stat(join(directory, 'SKILL.md')))) ||
        (depth > 0 &&
          depth <= 2 &&
          (await readSkillProject(directory, { legacy: depth === 2 })))
      )
        throw new SkillError('SKILL_CONFLICT', 409);
    }
  }

  async list(): Promise<InstalledSkills> {
    const skills: InstalledSkill[] = [];
    const enabled = await enabledPluginSkills(this.workspaceRoot);
    if (!(await this.directory([]))) return { root: this.root, skills };
    const visit = async (directory: string, path: string) => {
      const parts = path ? path.split('/') : [];
      if (
        !this.userId &&
        parts[0] === 'plugins' &&
        parts[1] &&
        !enabled.has(parts[1])
      )
        return;
      const entries = await readdir(directory, { withFileTypes: true });
      const project =
        parts.length === 1 || parts.length === 2
          ? await readSkillProject(directory, { legacy: parts.length === 2 })
          : undefined;
      if (project) {
        const projectRoot =
          project.root === '.' ? path : `${path}/${project.root}`;
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
              parts.length === 1 || parts[0] === '@local'
                ? 'archive'
                : 'github',
          });
        }
        return;
      }
      const manifest = entries.find(
        (entry) => entry.name === 'SKILL.md' && entry.isFile(),
      );
      if (manifest) {
        const name = basename(directory);
        const file = join(directory, manifest.name);
        const metadata = describe(await readFile(file, 'utf8'), name);
        skills.push({
          path,
          name,
          description: metadata.description,
          valid: metadata.valid,
          group: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
        });
        return;
      }
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.isDirectory() && !entry.name.startsWith('.'))
          await visit(
            join(directory, entry.name),
            path ? `${path}/${entry.name}` : entry.name,
          );
      }
    };
    await visit(this.root, '');
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
    projectVersion: 1 | 2 = 2,
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
      projectVersion,
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
    let preserveArchivePaths = false;
    try {
      if (mode === 'project' && !(await this.directory([repo]))) {
        const legacyDirectory = await this.directory(['@local', repo]);
        const legacy = legacyDirectory
          ? await readSkillProject(legacyDirectory, { legacy: true })
          : undefined;
        // Early archive projects kept the ZIP wrapper. Their already-installed
        // entry locations must not be rewritten merely by scanning the archive again.
        preserveArchivePaths =
          legacy?.version === 1 &&
          legacy.entries.every((entry) =>
            snapshot.files.some((file) => file.path === entry.path),
          );
      }
    } catch (error) {
      await snapshot.dispose();
      throw error;
    }
    if (mode === 'project' && !preserveArchivePaths) {
      const regular = snapshot.files.filter(isRegularFile);
      const prefix = `${regular[0]?.path.split('/')[0]}/`;
      if (
        regular.length &&
        regular.every((file) => file.path.startsWith(prefix))
      ) {
        if (prefix.slice(0, -1).toLowerCase() === SKILL_META_DIRECTORY) {
          await snapshot.dispose();
          throw new SkillError('SKILL_CONFLICT', 409);
        }
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
    return this.scanSnapshot(
      {
        owner: '@local',
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
    projectVersion: 1 | 2 = 2,
  ): Promise<SkillScan> {
    try {
      if (signal?.aborted) throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
      const projectMode =
        mode === 'project' || original?.installation?.mode === 'project';
      let group =
        projectMode && filename
          ? repository.repo
          : `${repository.owner}/${repository.repo}`;
      if (!this.userId && projectMode && ['plugins', 'builtin'].includes(group))
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      let parent = await this.directory(group.split('/'));
      if (projectMode && filename && !parent) {
        const legacyGroup = `@local/${repository.repo}`;
        const legacyDirectory = await this.directory(legacyGroup.split('/'));
        if (
          legacyDirectory &&
          (await readSkillProject(legacyDirectory, { legacy: true }))
            ?.version === 1
        ) {
          group = legacyGroup;
          parent = legacyDirectory;
          projectVersion = 1;
        }
      }
      await this.assertImportAncestors(group.split('/'), false);
      if (
        projectMode &&
        projectVersion === 2 &&
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
        const projectRoot = projectVersion === 1 ? `${group}/project` : group;
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
              destination: `${projectRoot}${folder === '.' ? '' : `/${folder}`}`,
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
            destination: projectRoot,
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
          projectGroup: group,
          projectVersion,
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
      ].find((name) =>
        legacyPaths?.has(`${repository.owner}/${repository.repo}/${name}`),
      );
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
        const destination = `${repository.owner}/${repository.repo}/${name}`;
        const parent = await this.directory([
          repository.owner,
          repository.repo,
        ]);
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
      return this.withGroupLock(
        scan.projectGroup ?? `${scan.result.owner}/${scan.result.repo}`,
        () => this.installScan(id, paths),
      );
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
    if (!this.userId && parts[0] === 'plugins')
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
      if (!this.userId && owner === 'plugins')
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      if (cached.result.importMode === 'project')
        return await this.installProject(cached, selected);
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

  private async installProject(
    cached: CachedScan,
    selected: RepositorySkill[],
  ): Promise<InstalledSkill[]> {
    const groupPath = cached.projectGroup!;
    const parts = groupPath.split('/');
    if (!this.userId && ['plugins', 'builtin'].includes(groupPath))
      throw new SkillError('SKILL_UNSAFE_PATH', 403);
    if (cached.result.sourceType === 'archive' && cached.projectVersion === 2) {
      // An old archive group can be temporarily absent while an earlier layout is updated.
      if (await stat(join(this.root, '.@local.skill-install.lock')))
        throw new SkillError('SKILL_CONFLICT', 409);
      const legacy = await this.directory(['@local', cached.result.repo]);
      if (
        legacy &&
        (await readSkillProject(legacy, { legacy: true }))?.version === 1
      )
        throw new SkillError('SKILL_CONFLICT', 409);
    }
    await this.assertImportAncestors(parts);
    const parentDirectory = (await this.directory(parts.slice(0, -1), true))!;
    const destination = join(parentDirectory, parts.at(-1)!);
    if (await stat(destination)) throw new SkillError('SKILL_CONFLICT', 409);
    const project: SkillProject = skillProjectSchema.parse({
      version: cached.projectVersion ?? 2,
      root: cached.projectVersion === 1 ? 'project' : '.',
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
      const root = join(group, project.root);
      await mkdir(root, { recursive: true });
      for (const file of cached.snapshot.files.filter(isRegularFile))
        await this.writeResource(root, file.path, file, cached.snapshot);
      const metadata =
        project.version === 1 ? group : join(group, SKILL_META_DIRECTORY);
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
      projectRoot:
        project.root === '.' ? groupPath : `${groupPath}/${project.root}`,
      sourceType: cached.result.sourceType === 'archive' ? 'archive' : 'github',
    }));
  }

  /** Resolve an installed package under this user's scope and serialize against updates/removal. */
  withFiles<T>(
    path: string,
    action: (root: string, skill: InstalledSkill) => Promise<T>,
  ): Promise<T> {
    return this.exclusive(async () => {
      if (path && !safeRepositoryPath(path))
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      const directory = await this.directory(path ? path.split('/') : []);
      const skill = (await this.list()).skills.find(
        (skill) => skill.path === path,
      );
      if (!directory || !skill) throw new SkillError('SKILL_NOT_FOUND', 404);
      try {
        return await action(directory, skill);
      } catch (error) {
        fileError(error);
      }
    });
  }

  read(path: string): Promise<SkillContent> {
    return this.exclusive(async () => {
      if (path && !safeRepositoryPath(path))
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      const directory = await this.directory(path ? path.split('/') : []);
      const skill = (await this.list()).skills.find(
        (skill) => skill.path === path,
      );
      if (!directory || !skill) throw new SkillError('SKILL_NOT_FOUND', 404);
      const manifest = join(directory, 'SKILL.md');
      const info = await stat(manifest);
      if (!info?.isFile() || info.isSymbolicLink())
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      return { skill, content: await readFile(manifest, 'utf8') };
    });
  }

  updateGroup(group: string, source?: string): Promise<InstalledSkill[]> {
    return this.exclusive(() =>
      this.withGroupLock(group, async () => {
        if (!this.userId && group.split('/')[0] === 'plugins')
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
        if (!safeRepositoryPath(group))
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
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
        if (project)
          return this.updateProject(group, directory, project, source);
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
    input?: string,
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
        project.version,
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

  remove(path: string) {
    return this.exclusive(async () => {
      if (!this.userId && path.split('/')[0] === 'plugins')
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      if (!safeRepositoryPath(path))
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      const target = await this.directory(path.split('/'));
      const selected = (await this.list()).skills.find(
        (skill) => skill.path === path,
      );
      if (!target || !selected) throw new SkillError('SKILL_NOT_FOUND', 404);
      if (selected.projectRoot)
        throw new SkillError('SKILL_PROJECT_MANAGED', 409);
      await rm(target, { recursive: true });
      const group = path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : '';
      if (!(await this.list()).skills.some((skill) => skill.group === group))
        await rm(join(dirname(target), SKILL_SOURCES_FILE), { force: true });
    });
  }

  removeGroup(group: string, expectedPaths: string[]) {
    return this.exclusive(() =>
      this.withGroupLock(group, async () => {
        if (!this.userId && group.split('/')[0] === 'plugins')
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
        if (!safeRepositoryPath(group))
          throw new SkillError('SKILL_UNSAFE_PATH', 403);
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
    ]);
    this.personalServices.clear();
  }
}
