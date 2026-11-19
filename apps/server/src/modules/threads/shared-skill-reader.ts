import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { InstalledSkillShareLink } from '../skills/share-links.js';
import {
  projectSharedSkillsRoot,
  resolveSkillShareLink,
} from '../skills/share-links.js';

type Share = InstalledSkillShareLink & {
  alias: string;
  root: string;
  entryDirectory: string;
};

function selected(link: InstalledSkillShareLink, alias: string, entry: string) {
  const project = link.project;
  return project
    ? project.entries.some(
        (item) => dirname(resolve(alias, project.root, item.path)) === entry,
      )
    : alias === entry;
}
export class SkillShareUnavailable extends Error {
  constructor() {
    super('SKILL_SHARE_UNAVAILABLE');
  }
}

/** The skill source reads shared packages through their published locations. No personal path
 * is added to the conversation filesystem, and the link is checked again for cached skills. */
export class SharedSkillReader {
  private readonly scopes: string[];
  private readonly sharedProject?: string;
  private readonly localProject?: string;
  private readonly shares = new Map<string, Share>();
  private canonical?: Promise<string>;

  constructor(
    private readonly workspace: string,
    projectId?: string,
  ) {
    const global = resolve(workspace, '.agents', 'skills');
    if (projectId) {
      this.sharedProject = projectSharedSkillsRoot(workspace, projectId);
      this.localProject = resolve(
        workspace,
        'projects',
        projectId,
        '.agents',
        'skills',
      );
    }
    this.scopes =
      this.sharedProject && this.localProject
        ? [global, this.sharedProject, this.localProject]
        : [global];
  }

  async register(path: string) {
    const root = this.scopes.find((scope) => path.startsWith(scope + sep));
    if (!root) return;
    const parts = relative(root, path).split(sep);
    // Protect the storage scope itself as well as symlinks below it.
    const canonicalRoot = await realpath(root);
    if (
      canonicalRoot !==
      resolve(
        await (this.canonical ??= realpath(this.workspace)),
        relative(this.workspace, root),
      )
    )
      throw new SkillShareUnavailable();
    let directory = root;
    for (const part of parts) {
      directory = join(directory, part);
      const info = await lstat(directory);
      if (!info.isSymbolicLink()) continue;
      if (root === this.localProject) throw new SkillShareUnavailable();
      const link = await resolveSkillShareLink(
        this.workspace,
        root,
        relative(root, directory),
      );
      if (!link || !selected(link, directory, path))
        throw new SkillShareUnavailable();
      const share = { ...link, alias: directory, root, entryDirectory: path };
      this.shares.set(path, share);
      return share;
    }
    if (root === this.sharedProject) throw new SkillShareUnavailable();
    this.shares.delete(path);
  }

  private match(path: string) {
    for (const share of this.shares.values()) {
      if (
        path === share.entryDirectory ||
        path.startsWith(share.entryDirectory + sep)
      )
        return share;
    }
  }

  async resolveFile(path: string) {
    const share = this.match(path);
    if (!share) {
      const scope = this.scopes.find((root) => path.startsWith(root + sep));
      if (!scope) return;
      // Cached local entries must not turn into unrestricted reads when a directory
      // or resource is replaced after discovery. New links require fresh discovery.
      if (
        scope === this.sharedProject ||
        (await realpath(path)) !==
          resolve(
            await (this.canonical ??= realpath(this.workspace)),
            relative(this.workspace, path),
          )
      )
        throw new SkillShareUnavailable();
      const info = await lstat(path);
      if (!info.isDirectory() && !(info.isFile() && info.nlink === 1))
        throw new SkillShareUnavailable();
      return path;
    }
    const current = await resolveSkillShareLink(
      this.workspace,
      share.root,
      share.unit,
    );
    if (
      !current ||
      current.userId !== share.userId ||
      current.directory !== share.directory ||
      !selected(current, share.alias, share.entryDirectory)
    )
      throw new SkillShareUnavailable();
    let filename = current.directory;
    for (const part of relative(share.alias, path).split(sep).filter(Boolean)) {
      filename = join(filename, part);
      const info = await lstat(filename);
      if (!info.isDirectory() && !(info.isFile() && info.nlink === 1))
        throw new SkillShareUnavailable();
    }
    return filename;
  }

  async read(path: string, filename: string) {
    const file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat({ bigint: true });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        (await this.resolveFile(path)) !== filename
      )
        throw new SkillShareUnavailable();
      const current = await lstat(filename, { bigint: true });
      if (info.dev !== current.dev || info.ino !== current.ino)
        throw new SkillShareUnavailable();
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async entries(path: string, filename: string) {
    const before = await lstat(filename, { bigint: true });
    const entries = await readdir(filename, { withFileTypes: true });
    const safe = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory())
          return { name: entry.name, type: 'directory' as const };
        if (
          entry.isFile() &&
          (await lstat(join(filename, entry.name))).nlink === 1
        )
          return { name: entry.name, type: 'file' as const };
      }),
    );
    if ((await this.resolveFile(path)) !== filename)
      throw new SkillShareUnavailable();
    const after = await lstat(filename, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino)
      throw new SkillShareUnavailable();
    return safe.filter((entry) => entry !== undefined);
  }
}
