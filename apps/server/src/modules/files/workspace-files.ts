import { posix, extname } from 'node:path';
import { AgentFSFilesystem } from '@mastra/agentfs';
import {
  CompositeFilesystem,
  LocalFilesystem,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import type {
  FileListing,
  FileMutation,
  FilePreview,
  FileSearch,
} from '@aime/shared/files';
import { ThreadError } from '../threads/errors.js';
import { filePath, validatePath } from './paths.js';
import {
  decodeText,
  listFiles,
  media,
  mutateFile,
  previewFile,
  TEXT_LIMIT,
} from './service.js';
import { searchFiles } from './search.js';

type Root = string | WorkspaceFilesystem;
export function resolveWorkspaceTarget(
  root: Root,
  path: string,
  allowRoot = false,
): { root: Root; path: string } {
  validatePath(path, allowRoot);
  if (root instanceof CompositeFilesystem) {
    const mount = root.getMountPathForPath(`/${path}`);
    const filesystem = root.getFilesystemForPath(`/${path}`);
    if (filesystem && mount)
      return resolveWorkspaceTarget(
        filesystem,
        `/${path}`.slice(mount.length).replace(/^\//, ''),
        true,
      );
  }
  return { root: root instanceof LocalFilesystem ? root.basePath : root, path };
}

const target = resolveWorkspaceTarget;

export async function listWorkspaceFiles(
  root: Root,
  path: string,
): Promise<FileListing> {
  const leaf = target(root, path, true);
  if (typeof leaf.root === 'string') {
    const result = await listFiles(leaf.root, leaf.path);
    return {
      ...result,
      entries: result.entries.map((entry) => ({
        ...entry,
        path: path ? `${path}/${entry.name}` : entry.name,
      })),
    };
  }
  const mountPaths =
    leaf.root instanceof CompositeFilesystem ? leaf.root.mountPaths : [];
  const entries = (await leaf.root.readdir(leaf.path || '/')).filter(
    (entry) => !entry.isSymlink && !entry.name.startsWith('._'),
  );
  return {
    entries: entries
      .slice(0, 2000)
      .map((entry) => ({
        name: entry.name,
        path: path ? `${path}/${entry.name}` : entry.name,
        kind: entry.type,
        ...(mountPaths.includes(posix.join('/', leaf.path, entry.name))
          ? { isMount: true }
          : {}),
      }))
      .sort(
        (a, b) =>
          Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
          a.name.localeCompare(b.name),
      ),
    truncated: entries.length > 2000,
  };
}

export async function previewWorkspaceFile(
  root: Root,
  path: string,
): Promise<FilePreview> {
  const leaf = target(root, path);
  if (typeof leaf.root === 'string')
    return { ...(await previewFile(leaf.root, leaf.path)), path };
  const info = await leaf.root.stat(leaf.path);
  if (info.type !== 'file') throw new ThreadError('FILE_NOT_FILE');
  const base = {
    path,
    size: info.size,
    modifiedAt: info.modifiedAt.toISOString(),
  };
  const format = media[extname(path).toLowerCase()];
  if (format) return { ...base, kind: format[0], mime: format[1] };
  if (!(leaf.root instanceof AgentFSFilesystem) || !leaf.root.agent)
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 404);
  const handle = await leaf.root.agent.fs.open(leaf.path);
  const buffer = await handle.pread(0, TEXT_LIMIT);
  const truncated = info.size > buffer.length;
  const text = decodeText(buffer, truncated);
  return text === null
    ? { ...base, kind: 'binary', mime: 'application/octet-stream' }
    : {
        ...base,
        kind: 'text',
        mime: 'text/plain; charset=utf-8',
        text,
        truncated,
      };
}

export async function localWorkspaceFile(root: Root, path: string) {
  const leaf = target(root, path);
  return typeof leaf.root === 'string'
    ? filePath(leaf.root, leaf.path)
    : undefined;
}

export async function streamWorkspaceFile(
  root: Root,
  path: string,
  write: (chunk: Uint8Array) => Promise<unknown>,
  aborted: () => boolean,
  start = 0,
  end = Infinity,
) {
  const leaf = target(root, path);
  if (!(leaf.root instanceof AgentFSFilesystem) || !leaf.root.agent)
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 404);
  if (!(await leaf.root.isFile(leaf.path)))
    throw new ThreadError('FILE_NOT_FILE');
  const handle = await leaf.root.agent.fs.open(leaf.path);
  for (let offset = start; !aborted() && offset <= end;) {
    const chunk = await handle.pread(
      offset,
      Math.min(64 * 1024, end - offset + 1),
    );
    if (!chunk.length) break;
    await write(chunk);
    offset += chunk.length;
  }
}

const locks = new Map<string, Promise<unknown>>();
export function withWorkspaceFileLock<T>(
  filesystem: WorkspaceFilesystem,
  action: () => Promise<T>,
): Promise<T> {
  const key =
    filesystem instanceof AgentFSFilesystem
      ? (filesystem.getInfo().metadata?.dbPath ?? filesystem.id)
      : filesystem.id;
  const pending = (locks.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(action);
  locks.set(key, pending);
  void pending
    .finally(() => {
      if (locks.get(key) === pending) locks.delete(key);
    })
    .catch(() => undefined);
  return pending;
}
export function mutateWorkspaceFile(
  root: Root,
  input: FileMutation,
): Promise<{ path: string }> {
  const leaf = target(root, input.path);
  // Composite roots and mount points are configuration, never mutable entries.
  if (!leaf.path || leaf.root instanceof CompositeFilesystem)
    throw new ThreadError('FILE_FORBIDDEN', 403);
  if (typeof leaf.root === 'string')
    return mutateFile(leaf.root, { ...input, path: leaf.path }).then(
      (result) => ({
        path:
          input.operation === 'rename'
            ? posix.join(posix.dirname(input.path), posix.basename(result.path))
            : input.path,
      }),
    );
  const filesystem = leaf.root;
  return withWorkspaceFileLock(filesystem, async () => {
    if (input.operation === 'create') {
      if (await filesystem.exists(leaf.path))
        throw new ThreadError('FILE_EXISTS', 409);
      const parent = posix.dirname(leaf.path);
      if (
        (await filesystem.stat(parent === '.' ? '/' : parent)).type !==
        'directory'
      )
        throw new ThreadError('FILE_NOT_FOUND', 404);
      if (input.kind === 'directory') await filesystem.mkdir(leaf.path);
      else
        await filesystem.writeFile(leaf.path, '', {
          overwrite: false,
          recursive: false,
        });
    } else if (input.operation === 'delete') {
      if ((await filesystem.stat(leaf.path)).type === 'directory')
        await filesystem.rmdir(leaf.path, { recursive: true });
      else await filesystem.deleteFile(leaf.path);
    } else {
      validatePath(input.name);
      if (input.name.includes('/')) throw new ThreadError('FILE_INVALID_PATH');
      const next = posix.join(posix.dirname(leaf.path), input.name);
      if (next !== leaf.path)
        await filesystem.moveFile(leaf.path, next, { overwrite: false });
      return { path: posix.join(posix.dirname(input.path), input.name) };
    }
    return { path: input.path };
  });
}

const ignored = new Set([
  '.git',
  'node_modules',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
]);
export async function searchWorkspaceFiles(
  root: Root,
  query: string,
  signal?: AbortSignal,
): Promise<FileSearch> {
  const leaf = target(root, '', true);
  if (typeof leaf.root === 'string')
    return searchFiles(leaf.root, query, signal);
  const result: FileSearch = { matches: [], truncated: false };
  const needle = query.toLocaleLowerCase();
  const deadline = Date.now() + 5000;
  let visited = 0;
  let bytes = 0;
  const queue = [{ path: '', depth: 0 }];
  while (queue.length) {
    if (
      signal?.aborted ||
      Date.now() > deadline ||
      visited >= 1000 ||
      result.matches.length >= 200
    ) {
      result.truncated = true;
      break;
    }
    const directory = queue.shift()!;
    const listing = await listWorkspaceFiles(root, directory.path);
    result.truncated ||= listing.truncated;
    for (const entry of listing.entries) {
      if (
        signal?.aborted ||
        Date.now() > deadline ||
        ++visited > 1000 ||
        result.matches.length >= 200
      ) {
        result.truncated = true;
        break;
      }
      if (entry.kind === 'directory') {
        if (!ignored.has(entry.name)) {
          if (directory.depth < 20)
            queue.push({ path: entry.path, depth: directory.depth + 1 });
          else result.truncated = true;
        }
        continue;
      }
      if (bytes >= 32 * 1024 * 1024) {
        result.truncated = true;
        break;
      }
      const preview = await previewWorkspaceFile(root, entry.path);
      const before = result.matches.length;
      if (preview.kind === 'text') {
        bytes += Math.min(preview.size, TEXT_LIMIT);
        result.truncated ||= !!preview.truncated;
        for (const [index, line] of preview.text!.split('\n').entries()) {
          if (line.toLocaleLowerCase().includes(needle))
            result.matches.push({
              ...entry,
              line: index + 1,
              text: line.slice(0, 500),
            });
          if (result.matches.length >= 200) {
            result.truncated = true;
            break;
          }
        }
      }
      if (
        before === result.matches.length &&
        entry.name.toLocaleLowerCase().includes(needle)
      )
        result.matches.push(entry);
    }
  }
  result.matches.sort(
    (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
  );
  return result;
}
