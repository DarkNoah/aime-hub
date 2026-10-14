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
import { userDirectory } from '../threads/workspace.js';
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
  type RepositoryFile,
  type RepositorySnapshot,
} from './github.js';

const SCAN_TTL = 15 * 60_000;
type CachedScan = {
  source: SkillSource;
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
      service = new SkillService(this.workspaceRoot, this.download, userId);
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

  async list(): Promise<InstalledSkills> {
    const skills: InstalledSkill[] = [];
    const enabled = await enabledPluginSkills(this.workspaceRoot);
    if (!(await this.directory([]))) return { root: this.root, skills };
    const visit = async (directory: string, path: string) => {
      const parts = path.split('/');
      if (
        !this.userId &&
        parts[0] === 'plugins' &&
        parts[1] &&
        !enabled.has(parts[1])
      )
        return;
      const entries = await readdir(directory, { withFileTypes: true });
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

  async scan(input: string, signal?: AbortSignal): Promise<SkillScan> {
    return this.scanRepository(input, signal);
  }

  private async scanRepository(
    input: string,
    signal?: AbortSignal,
    original?: SkillSource,
    legacyPaths?: Set<string>,
  ): Promise<SkillScan> {
    const repository = parseGitHubRepository(input);
    let snapshot: RepositorySnapshot | undefined;
    try {
      snapshot = await this.download(repository, signal, original);
      if (signal?.aborted) throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
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
        source: {
          url: normalizeSkillSource(input),
          ref: snapshot.ref ?? null,
          scope: snapshot.scopePath ?? '',
          installation,
        },
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
    return this.exclusive(() => this.installScan(id, paths));
  }

  private async installScan(
    id: string,
    paths: string[],
  ): Promise<InstalledSkill[]> {
    const cached = this.scans.get(id);
    try {
      if (!cached || Date.parse(cached.result.expiresAt) <= Date.now())
        throw new SkillError('SKILL_SCAN_EXPIRED', 410);
      const selected = [...new Set(paths)].map((path) => {
        const skill = cached.result.skills.find((skill) => skill.path === path);
        if (!skill || !skill.valid)
          throw new SkillError('SKILL_INVALID_SELECTION');
        return skill;
      });
      if (!selected.length) throw new SkillError('SKILL_INVALID_SELECTION');
      const { owner, repo } = cached.result;
      if (!this.userId && owner === 'plugins')
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      // An existing manifest on an ancestor would hide all installed children at runtime.
      for (const parts of [[], [owner], [owner, repo]]) {
        const parent = await this.directory(parts, true);
        if (await stat(join(parent!, 'SKILL.md')))
          throw new SkillError('SKILL_CONFLICT', 409);
      }
      const parent = (await this.directory([owner, repo], true))!;
      const sources = await readSkillSources(parent);
      for (const skill of selected) {
        if (await stat(join(parent, skill.name)))
          throw new SkillError('SKILL_CONFLICT', 409);
      }
      const staging = await mkdtemp(
        join(dirname(this.root), '.skill-install-'),
      );
      const installed: string[] = [];
      try {
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
    return this.exclusive(async () => {
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
          (scan) => this.scans.get(scan.id)!.source,
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
    });
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
      if (
        !target ||
        !(await this.list()).skills.some((skill) => skill.path === path)
      )
        throw new SkillError('SKILL_NOT_FOUND', 404);
      await rm(target, { recursive: true });
      const group = path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : '';
      if (!(await this.list()).skills.some((skill) => skill.group === group))
        await rm(join(dirname(target), SKILL_SOURCES_FILE), { force: true });
    });
  }

  removeGroup(group: string, expectedPaths: string[]) {
    return this.exclusive(async () => {
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
      const targets: { path: string; directory: string }[] = [];
      for (const skill of skills) {
        const directory = await this.directory(skill.path.split('/'));
        if (!directory) throw new SkillError('SKILL_GROUP_CHANGED', 409);
        targets.push({ path: skill.path, directory });
      }
      // Only remove the skills shown in this group, not sibling groups or loose files.
      const staging = await mkdtemp(join(dirname(this.root), '.skill-remove-'));
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
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
      });
      return targets.map((target) => target.path);
    });
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
