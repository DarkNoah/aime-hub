import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  projectGitHubSourceSchema,
  type ProjectGitHubSource,
} from '@aime/shared/projects';
import { ThreadError } from '../threads/errors.js';
import { projectDirectory } from '../threads/workspace.js';

export type CloneRepository = (
  source: ProjectGitHubSource,
  directory: string,
) => Promise<void>;

/** Clone public repositories without inheriting credentials, hooks, or filters. */
export const cloneGitHubRepository: CloneRepository = async (
  input,
  directory,
) => {
  const source = projectGitHubSourceSchema.parse(input);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
  };
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  await new Promise<void>((done, reject) => {
    const grouped = process.platform !== 'win32';
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
        '-c',
        'http.version=HTTP/1.1',
        'clone',
        '--quiet',
        '--depth=1',
        '--single-branch',
        '--no-tags',
        '--template=',
        ...(source.branch ? ['--branch', source.branch] : []),
        '--',
        source.repositoryUrl,
        directory,
      ],
      {
        env,
        detached: grouped,
        stdio: 'ignore',
      },
    );
    let failure: NodeJS.ErrnoException | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // Stop the HTTPS transport as well before cleaning up its destination.
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          child.kill('SIGKILL');
      }
    }, 120_000);
    timeout.unref();
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (failure?.code === 'ENOENT')
        reject(new ThreadError('PROJECT_GIT_UNAVAILABLE', 503));
      else if (timedOut) reject(new ThreadError('PROJECT_CLONE_TIMEOUT', 504));
      else if (failure || code !== 0)
        reject(new ThreadError('PROJECT_CLONE_FAILED', 502));
      else done();
    });
  });
};

/** Reserve a fresh workspace, and return cleanup for a failed database commit. */
export async function importGitHubProject(
  root: string,
  projectId: string,
  source: ProjectGitHubSource,
  clone: CloneRepository = cloneGitHubRepository,
) {
  const directory = projectDirectory(root, projectId);
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const parent = resolve(root, 'projects');
  await mkdir(parent, { recursive: true });
  if (
    (await lstat(parent)).isSymbolicLink() ||
    (await realpath(parent)) !== resolve(canonicalRoot, 'projects')
  )
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 409);
  // Exclusive creation means failure can never delete an existing project.
  await mkdir(directory, { mode: 0o700 });
  const original = await lstat(directory);
  const rollback = async () => {
    if ((await realpath(parent)) !== resolve(canonicalRoot, 'projects'))
      throw new ThreadError('WORKSPACE_UNAVAILABLE', 409);
    const current = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (!current) return;
    if (
      current.isSymbolicLink() ||
      current.ino !== original.ino ||
      current.dev !== original.dev
    )
      throw new ThreadError('WORKSPACE_UNAVAILABLE', 409);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await clone(source, directory);
    return rollback;
  } catch (error) {
    await rollback();
    throw error;
  }
}
