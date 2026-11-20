import { readlink, symlink, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeRepositoryPath } from './github.js';
import { conflict, directoriesExist, fileInfo } from './layout-journal.js';

/** Occupies the installer's lock path atomically, including its owner token.
 * The link is never followed: its target identifies the persisted journal. */
export class LayoutLocks {
  readonly paths: Set<string>;
  private readonly token: string;

  constructor(
    private readonly root: string,
    readonly id: string,
    paths: string[],
    private readonly save: (paths: string[]) => Promise<void>,
  ) {
    if (!/^[a-f\d-]{36}$/.test(id)) conflict(id);
    this.token = `skill-layout-migration-${id}`;
    this.paths = new Set(paths);
  }

  private async checked(path: string) {
    if (
      !safeRepositoryPath(path) ||
      !/^(?:\.agents\/(?:skills|project-skills\/[\w-]{16})|(?:users\/[\w-]+|projects\/[\w-]{16})\/\.agents\/skills)\/\.[^/]+\.skill-install\.lock$/.test(
        path,
      )
    )
      conflict(path);
    const absolute = join(this.root, path);
    if (!(await directoriesExist(this.root, dirname(absolute))))
      conflict(absolute);
    return absolute;
  }

  private async owned(path: string) {
    const info = await fileInfo(path);
    return info?.isSymbolicLink() && (await readlink(path)) === this.token;
  }

  private async acquire(path: string) {
    const absolute = await this.checked(path);
    if (this.paths.has(path) && (await this.owned(absolute))) return;
    const added = !this.paths.has(path);
    if (added) {
      this.paths.add(path);
      // Persist intent first, so even an interruption immediately after symlink()
      // leaves a lock whose ownership can be verified from the journal.
      await this.save([...this.paths]);
    }
    try {
      await symlink(this.token, absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (await this.owned(absolute)) return;
        if (added) {
          this.paths.delete(path);
          await this.save([...this.paths]);
        }
        conflict(absolute);
      }
      throw error;
    }
  }

  async group(store: string, ...groups: string[]) {
    for (const top of new Set(groups.map((group) => group.split('/')[0])))
      await this.acquire(join(store, `.${top}.skill-install.lock`));
  }

  async restore() {
    for (const path of this.paths) await this.acquire(path);
  }

  async release() {
    for (const path of [...this.paths].reverse()) {
      const absolute = await this.checked(path);
      // A saved intent may never have acquired this path, or a prior cleanup may
      // already have released it. Never remove another operation's lock.
      if (await this.owned(absolute)) await unlink(absolute);
    }
  }
}
