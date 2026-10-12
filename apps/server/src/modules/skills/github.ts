import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SkillError } from './errors.js';

export type GitHubRepository = {
  owner: string;
  repo: string;
  url: string;
  kind?: 'tree' | 'blob';
  refPath?: string;
};
export type RepositoryFile = {
  path: string;
  oid: string;
  size: number;
  mode: string;
};
export type RepositorySnapshot = {
  commit: string;
  files: RepositoryFile[];
  scopePath?: string;
  fileOnly?: boolean;
  ref?: string;
  read: (file: RepositoryFile) => Promise<Buffer>;
  write?: (file: RepositoryFile, output: string) => Promise<void>;
  dispose: () => Promise<void>;
};

export function parseGitHubRepository(input: string): GitHubRepository {
  input = input.trim();
  if (/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(input))
    input = `https://github.com/${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SkillError('SKILL_INVALID_URL');
  }
  const match =
    /^\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)(?:\/(tree|blob)\/(.+?))?\/?$/.exec(
      url.pathname,
    );
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    input.includes('\\') ||
    input.includes('/../') ||
    input.includes('/./')
  )
    throw new SkillError('SKILL_INVALID_URL');
  const owner = match[1].toLowerCase();
  const repo = match[2].replace(/\.git$/, '').toLowerCase();
  if (!repo || repo === '.' || repo === '..' || repo.startsWith('.'))
    throw new SkillError('SKILL_INVALID_URL');
  let refPath: string | undefined;
  try {
    refPath = match[4]
      ? decodeURIComponent(match[4]).replace(/\/$/, '')
      : undefined;
  } catch {
    throw new SkillError('SKILL_INVALID_URL');
  }
  if (refPath && !safeRepositoryPath(refPath))
    throw new SkillError('SKILL_INVALID_URL');
  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
    ...(refPath ? { kind: match[3] as 'tree' | 'blob', refPath } : {}),
  };
}

async function git(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
  output?: Writable,
) {
  const child = spawn(
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'http.followRedirects=false',
      ...args,
    ],
    {
      cwd,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Do not inherit Git configs, credential helpers, or repository variables.
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
      },
    },
  );
  const completion = new Promise<{ stdout: Buffer }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let failure: Error | undefined;
    if (!output) child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on('error', (error) => {
      failure = error;
    });
    // Wait for the process to exit before callers remove its temporary files.
    child.on('close', (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Git command failed'));
      else resolve({ stdout: Buffer.concat(chunks) });
    });
  });
  if (!output) return completion;
  const transfer = pipeline(child.stdout, output).catch((error) => {
    child.kill();
    throw error;
  });
  const results = await Promise.allSettled([completion, transfer]);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
  return { stdout: Buffer.alloc(0) };
}

export function safeRepositoryPath(path: string) {
  return (
    path.length > 0 &&
    !path.includes('\\') &&
    !Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

/** Read Git objects without checking out files, following links, or running repository code. */
export async function readGitSnapshot(
  directory: string,
  revision = 'HEAD',
  signal?: AbortSignal,
): Promise<RepositorySnapshot> {
  const results = await Promise.allSettled([
    git(['rev-parse', revision], directory, signal),
    git(['ls-tree', '-rlz', revision], directory, signal),
  ]);
  const [head, tree] = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  const files = tree.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const match =
        /^(\d+) (?:blob|commit) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(row);
      if (!match || !safeRepositoryPath(match[4]))
        throw new SkillError('SKILL_UNSAFE_REPOSITORY');
      return {
        mode: match[1],
        oid: match[2],
        size: match[3] === '-' ? 0 : Number(match[3]),
        path: match[4],
      };
    });
  return {
    commit: head.stdout.toString('utf8').trim(),
    files,
    async read(file) {
      if (!isRegularFile(file)) throw new SkillError('SKILL_UNSAFE_REPOSITORY');
      return (await git(['cat-file', 'blob', file.oid], directory)).stdout;
    },
    async write(file, output) {
      if (!isRegularFile(file)) throw new SkillError('SKILL_UNSAFE_REPOSITORY');
      await git(
        ['cat-file', 'blob', file.oid],
        directory,
        undefined,
        createWriteStream(output, {
          flags: 'wx',
          mode: file.mode === '100755' ? 0o755 : 0o644,
        }),
      );
    },
    dispose: async () => {},
  };
}

export function isRegularFile(file: RepositoryFile) {
  return file.mode === '100644' || file.mode === '100755';
}

export async function downloadGitHubRepository(
  repository: GitHubRepository,
  signal?: AbortSignal,
  original?: { ref: string | null; scope: string },
): Promise<RepositorySnapshot> {
  const source = `${repository.url}.git`;
  const remotes = [
    source,
    `https://githubproxy.cc/${source}`,
    `https://ghfast.top/${source}`,
  ];
  for (const [index, remote] of remotes.entries()) {
    try {
      return await downloadRepository(repository, remote, signal, original);
    } catch (error) {
      if (
        signal?.aborted ||
        !(error instanceof SkillError) ||
        error.code !== 'SKILL_DOWNLOAD_FAILED' ||
        index === remotes.length - 1
      )
        throw error;
      // Retry the entire transport in a fresh directory; keep the canonical GitHub source.
    }
  }
  throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
}

async function downloadRepository(
  repository: GitHubRepository,
  remote: string,
  signal?: AbortSignal,
  original?: { ref: string | null; scope: string },
): Promise<RepositorySnapshot> {
  const directory = await mkdtemp(join(tmpdir(), 'skill-repository-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    let ref: string | undefined = original?.ref ?? undefined;
    let scopePath: string | undefined = original?.scope;
    if (repository.refPath && !original) {
      const refs = await git(
        ['ls-remote', '--heads', '--tags', '--', remote],
        undefined,
        signal,
      );
      ({ ref, scopePath } = resolveRepositoryScope(
        repository.refPath,
        refs.stdout.toString('utf8'),
      ));
    }
    const checkout = join(directory, 'repo');
    let revision = 'HEAD';
    if (ref && /^[a-f0-9]{40}$/.test(ref)) {
      await git(['init', '--', checkout], undefined, signal);
      await git(['fetch', '--depth=1', '--', remote, ref], checkout, signal);
      revision = 'FETCH_HEAD';
    } else {
      await git(
        [
          'clone',
          '--depth=1',
          '--single-branch',
          '--no-tags',
          '--no-checkout',
          ...(ref ? ['--branch', ref] : []),
          '--',
          remote,
          checkout,
        ],
        undefined,
        signal,
      );
    }
    const snapshot = await readGitSnapshot(checkout, revision, signal);
    if (repository.kind === 'blob') {
      const file = snapshot.files.find(
        (file) =>
          file.path === scopePath ||
          (file.path.toLowerCase() === scopePath?.toLowerCase() &&
            /(^|\/)SKILL\.md$/.test(file.path)),
      );
      if (!file || !/(^|\/)SKILL\.md$/.test(file.path) || !isRegularFile(file))
        throw new SkillError('SKILL_SOURCE_NOT_FOUND', 404);
      scopePath = file.path;
    } else if (
      scopePath &&
      !snapshot.files.some((file) => file.path.startsWith(`${scopePath}/`))
    ) {
      throw new SkillError('SKILL_SOURCE_NOT_FOUND', 404);
    }
    return {
      ...snapshot,
      scopePath,
      ref,
      fileOnly: repository.kind === 'blob',
      dispose,
    };
  } catch (error) {
    await dispose();
    if (error instanceof SkillError) throw error;
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      throw new SkillError('SKILL_GIT_UNAVAILABLE', 503);
    throw new SkillError('SKILL_DOWNLOAD_FAILED', 502);
  }
}

/** Prefer the longest matching branch/tag so refs containing slashes work. */
export function resolveRepositoryScope(refPath: string, refs: string) {
  const candidates = refs
    .split('\n')
    .flatMap((line) => {
      const match = /^[a-f0-9]+\trefs\/(?:heads|tags)\/(.+)$/.exec(line);
      return match && !match[1].endsWith('^{}') ? [match[1]] : [];
    })
    .filter((ref) => refPath === ref || refPath.startsWith(`${ref}/`))
    .sort((a, b) => b.length - a.length);
  const ref =
    candidates[0] ??
    (/^[a-f0-9]{40}(?:\/|$)/.test(refPath) ? refPath.slice(0, 40) : undefined);
  if (!ref) throw new SkillError('SKILL_SOURCE_NOT_FOUND', 404);
  return { ref, scopePath: refPath.slice(ref.length).replace(/^\//, '') };
}
