import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { safeRepositoryPath } from './github.js';

export type LayoutStep =
  | { op: 'move'; from: string; path: string; id: string }
  | { op: 'unlink'; path: string; id: string }
  | { op: 'link'; path: string; target: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'mkdir' | 'rmdir'; path: string };

export async function fileInfo(path: string) {
  return lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

// AgentFS inode numbers persist in its database. Its device number belongs to
// the transient FUSE/NFS mount and changes on remount.
export function identity(info: { dev: bigint; ino: bigint }, mounted = false) {
  return `${mounted ? 'mounted' : info.dev}:${info.ino}`;
}

function matches(info: { dev: bigint; ino: bigint }, id: string) {
  return identity(info, id.startsWith('mounted:')) === id;
}

export function conflict(path: string): never {
  throw new Error(`技能目录迁移冲突，请检查 ${path}`);
}

// Never follow a link in the path to a managed store or an operation's parent.
export async function directoriesExist(root: string, path: string) {
  let dir = root;
  const suffix = relative(root, path);
  if (!suffix) return true;
  if (!safeRepositoryPath(suffix)) conflict(path);
  for (const part of suffix.split('/')) {
    dir = join(dir, part);
    const info = await fileInfo(dir);
    if (!info) return false;
    if (!info.isDirectory()) return false;
  }
  return true;
}

export async function atomicJson(path: string, value: unknown) {
  const temporary = join(dirname(path), `.skill-layout-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Only the current step can be replayed after an interrupted startup. Check inode
// identity before renames/unlinks and verify completed writes before advancing.
export async function applyLayoutStep(root: string, step: LayoutStep) {
  async function checked(path: string) {
    if (
      !safeRepositoryPath(path) ||
      !/^(?:\.agents\/(?:skills|project-skills\/[\w-]{16})|(?:users\/[\w-]+|projects\/[\w-]{16})\/\.agents\/skills)\//.test(
        path,
      )
    )
      conflict(path);
    const absolute = join(root, path);
    if (!(await directoriesExist(root, dirname(absolute)))) conflict(absolute);
    return absolute;
  }
  const path = await checked(step.path);
  const info = await fileInfo(path);
  switch (step.op) {
    case 'move': {
      const source = await checked(step.from);
      const old = await fileInfo(source);
      if (!old && info && matches(info, step.id)) return;
      if (info || !old || !matches(old, step.id)) conflict(path);
      await rename(source, path);
      return;
    }
    case 'mkdir':
      if (info && !info.isDirectory()) conflict(path);
      if (!info) await mkdir(path);
      return;
    case 'write':
      if (info) {
        if (!info.isFile() || (await readFile(path, 'utf8')) !== step.content)
          conflict(path);
      } else {
        // Publish complete metadata. An interrupted write cannot leave a partial marker.
        await atomicJson(path, JSON.parse(step.content));
      }
      return;
    case 'unlink':
      if (!info) return;
      if (!matches(info, step.id) || info.isDirectory()) conflict(path);
      await unlink(path);
      return;
    case 'link':
      if (info) {
        if (!info.isSymbolicLink() || (await readlink(path)) !== step.target)
          conflict(path);
      } else await symlink(step.target, path, 'dir');
      return;
    case 'rmdir':
      if (info) await rmdir(path);
      return;
  }
}
