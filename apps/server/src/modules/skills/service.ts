import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
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
} from '@aime/shared/skills';
import { SkillError } from './errors.js';
import {
  downloadGitHubRepository,
  isRegularFile,
  parseGitHubRepository,
  safeRepositoryPath,
  type RepositoryFile,
  type RepositorySnapshot,
} from './github.js';

const SCAN_TTL = 15 * 60_000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_INSTALL_BYTES = 200 * 1024 * 1024;
type CachedScan = {
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
  private downloading = 0;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private workspaceRoot: string,
    private download = downloadGitHubRepository,
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.root = join(this.workspaceRoot, '.agents', 'skills');
  }

  /** Check each component, including absent ancestors, before any read/write. */
  private async directory(
    parts: string[],
    create = false,
  ): Promise<string | null> {
    let current = this.workspaceRoot;
    if (create) await mkdir(current, { recursive: true });
    for (const part of ['.agents', 'skills', ...parts]) {
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
    if (!(await this.directory([]))) return { root: this.root, skills };
    const visit = async (directory: string, path: string, depth: number) => {
      if (depth > 12 || skills.length >= 500) return;
      const entries = await readdir(directory, { withFileTypes: true });
      const manifest = entries.find(
        (entry) => entry.name === 'SKILL.md' && entry.isFile(),
      );
      if (manifest) {
        const name = basename(directory);
        const file = join(directory, manifest.name);
        const info = await lstat(file);
        const metadata =
          info.size <= MAX_MANIFEST_BYTES
            ? describe(await readFile(file, 'utf8'), name)
            : { description: '', valid: false };
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
            depth + 1,
          );
      }
    };
    await visit(this.root, '', 0);
    return { root: this.root, skills };
  }

  async scan(input: string, signal?: AbortSignal): Promise<SkillScan> {
    const repository = parseGitHubRepository(input);
    if (this.downloading + this.scans.size >= 3)
      throw new SkillError('SKILL_SCAN_LIMIT', 429);
    this.downloading++;
    let snapshot: RepositorySnapshot | undefined;
    try {
      snapshot = await this.download(repository, signal);
      if (signal?.aborted) throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
      // Resolve names across the whole repository so scoped and full scans use identical destinations.
      const manifests = snapshot.files.filter(
        (file) => isRegularFile(file) && /(^|\/)SKILL\.md$/.test(file.path),
      );
      if (manifests.length > 500)
        throw new SkillError('SKILL_REPOSITORY_LIMIT', 413);
      const candidates = [];
      for (const file of manifests) {
        if (signal?.aborted) throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
        const content =
          file.size <= MAX_MANIFEST_BYTES
            ? (await snapshot.read(file)).toString('utf8')
            : '';
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
      const skills: RepositorySkill[] = [];
      for (const { file, content, name: baseName } of candidates) {
        if (
          snapshot.scopePath &&
          (snapshot.fileOnly
            ? file.path !== snapshot.scopePath
            : !file.path.startsWith(`${snapshot.scopePath}/`))
        )
          continue;
        const name =
          counts.get(baseName)! > 1
            ? `${baseName}-${createHash('sha256').update(file.path).digest('hex').slice(0, 8)}`
            : baseName;
        const files = skillFiles(snapshot, file.path);
        const regular = files.filter(isRegularFile);
        const metadata = describe(content, name);
        if (regular.some((entry) => entry.size > 20 * 1024 * 1024)) {
          metadata.valid = false;
          metadata.errors.push('A bundled file exceeds the 20 MB limit.');
        }
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
      this.scans.set(result.id, { result, snapshot, timer });
      return result;
    } catch (error) {
      await snapshot?.dispose();
      throw error;
    } finally {
      this.downloading--;
    }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(action);
    this.mutations = pending.catch(() => {});
    return pending;
  }

  discard(id: string) {
    return this.exclusive(async () => {
      const scan = this.scans.get(id);
      if (!scan) return;
      this.scans.delete(id);
      clearTimeout(scan.timer);
      await scan.snapshot.dispose();
    });
  }

  install(id: string, paths: string[]): Promise<InstalledSkill[]> {
    return this.exclusive(async () => {
      const cached = this.scans.get(id);
      if (!cached || Date.parse(cached.result.expiresAt) <= Date.now())
        throw new SkillError('SKILL_SCAN_EXPIRED', 410);
      const selected = [...new Set(paths)].map((path) => {
        const skill = cached.result.skills.find((skill) => skill.path === path);
        if (!skill || !skill.valid)
          throw new SkillError('SKILL_INVALID_SELECTION');
        return skill;
      });
      if (
        !selected.length ||
        selected.reduce((size, skill) => size + skill.bytes, 0) >
          MAX_INSTALL_BYTES
      )
        throw new SkillError('SKILL_REPOSITORY_LIMIT', 413);
      const { owner, repo } = cached.result;
      // An existing manifest on an ancestor would hide all installed children at runtime.
      for (const parts of [[], [owner], [owner, repo]]) {
        const parent = await this.directory(parts, true);
        if (await stat(join(parent!, 'SKILL.md')))
          throw new SkillError('SKILL_CONFLICT', 409);
      }
      const parent = (await this.directory([owner, repo], true))!;
      for (const skill of selected) {
        if (await stat(join(parent, skill.name)))
          throw new SkillError('SKILL_CONFLICT', 409);
      }
      const staging = await mkdtemp(
        join(this.workspaceRoot, '.agents', '.skill-install-'),
      );
      const installed: string[] = [];
      try {
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
    await writeFile(output, await snapshot.read(file), {
      flag: 'wx',
      mode: file.mode === '100755' ? 0o755 : 0o644,
    });
  }

  remove(path: string) {
    return this.exclusive(async () => {
      if (!safeRepositoryPath(path))
        throw new SkillError('SKILL_UNSAFE_PATH', 403);
      const target = await this.directory(path.split('/'));
      if (
        !target ||
        !(await this.list()).skills.some((skill) => skill.path === path)
      )
        throw new SkillError('SKILL_NOT_FOUND', 404);
      await rm(target, { recursive: true });
    });
  }

  async dispose() {
    await Promise.all([...this.scans.keys()].map((id) => this.discard(id)));
  }
}
