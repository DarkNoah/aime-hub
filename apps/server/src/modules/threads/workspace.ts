import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, relative, basename, dirname, isAbsolute } from 'node:path';
import { nanoid } from 'nanoid';
import {
  CompositeFilesystem,
  LocalFilesystem,
  LocalSandbox,
  Workspace,
  WORKSPACE_TOOLS,
  type WorkspaceFilesystem,
} from '@mastra/core/workspace';
import { ThreadError } from './errors.js';
import { directorySkillConfig } from './skill-source.js';
import { workspaceLspConfig, workspaceLspHooks } from './workspace-lsp.js';
import {
  projectWorkspaceSchema,
  type ProjectWorkspace,
} from '@aime/shared/projects';

export function userDirectory(root: string, userId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new ThreadError('INVALID_USER');
  return resolve(root, 'users', userId);
}

export function projectDirectory(root: string, projectId: string) {
  if (!/^[a-zA-Z0-9_-]{16}$/.test(projectId))
    throw new ThreadError('PROJECT_NOT_FOUND', 404);
  return resolve(root, 'projects', projectId);
}

export async function createProjectWorkspace(root: string, projectId: string) {
  const path = projectDirectory(root, projectId);
  await mkdir(path, { recursive: true });
  return path;
}

export async function createPersonalWorkspace(root: string, userId: string) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const path = resolve(userDirectory(root, userId), `${date}-${nanoid(6)}`);
  await mkdir(path, { recursive: true });
  return path;
}

export async function removePersonalWorkspace(
  root: string,
  userId: string,
  directory: string,
) {
  const ownerDirectory = userDirectory(root, userId);
  if (
    !isAbsolute(directory) ||
    directory !== resolve(directory) ||
    dirname(directory) !== ownerDirectory ||
    !/^\d{4}-\d{2}-\d{2}-[a-zA-Z0-9_-]{6}$/.test(basename(directory))
  )
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 409);

  const existingPath = async (path: string) =>
    realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const canonicalRoot = await existingPath(root);
  const canonicalOwner = await existingPath(ownerDirectory);
  if (!canonicalRoot || !canonicalOwner) return;
  // A symlink in users/ or the user folder must not redirect recursive removal.
  if (canonicalOwner !== resolve(canonicalRoot, 'users', userId))
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 409);
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ThreadError('WORKSPACE_UNAVAILABLE', 409);
  await rm(directory, { recursive: true, force: true });
}

export function getWorkspace(
  root: string,
  userId: string,
  path: string,
  projectId?: string,
  skillPaths: Parameters<typeof directorySkillConfig>[0] = [],
  filesystem?: WorkspaceFilesystem,
) {
  const valid = projectId
    ? path === projectDirectory(root, projectId)
    : dirname(path) === userDirectory(root, userId);
  if (!valid) throw new ThreadError('WORKSPACE_UNAVAILABLE', 500);
  const userPath = userDirectory(root, userId);
  const workspaceFilesystem =
    filesystem ??
    new LocalFilesystem({
      basePath: path,
      contained: true,
      allowedPaths: [...(projectId ? [] : [userPath])],
    });
  const workingDirectory =
    workspaceFilesystem instanceof LocalFilesystem
      ? workspaceFilesystem.basePath
      : path;
  return new Workspace({
    ...directorySkillConfig(skillPaths),
    id: basename(path),
    filesystem: workspaceFilesystem,
    sandbox: new LocalSandbox({
      workingDirectory,
      env: {
        // NODE_ENV: 'development',
        SKILL_HOME: projectId ? resolve(projectDirectory(root, projectId), '.agents', 'skills') : resolve(userPath, '.agents', 'skills'),
      },
    }),
    lsp: workspaceLspConfig(workingDirectory),
    bm25: true,
    tools: {
      hooks: workspaceLspHooks(workingDirectory, workspaceFilesystem),
      [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
        name: 'lsp_inspect',
      },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
        name: 'execute_command',
      },
      [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: {
        name: 'get_process_output',
      },
      [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
        name: 'kill_process',
      },
      [WORKSPACE_TOOLS.SEARCH.INDEX]: {
        // enabled: false,
        name: 'index',
      },
      [WORKSPACE_TOOLS.SEARCH.SEARCH]: {
        // enabled: false,
        name: 'search',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
        // enabled: false,
        name: 'write_file',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
        // enabled: false,
        name: 'read_file',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
        // enabled: false,
        name: 'edit_file',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
        // enabled: false,
        name: 'grep',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
        enabled: false,
        name: 'list_files',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: {
        enabled: false,
        name: 'file_stat',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: {
        enabled: false,
        name: 'mkdir',
      },
      [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
        enabled: false,
        name: 'delete',
      },
    },
  });
}

export type DiscoveredSkill = { id: string; group: string; path: string };
export function discoverInstalledSkills(root: string) {
  return discover(resolve(root, '.agents', 'skills'));
}
async function discover(root: string): Promise<DiscoveredSkill[]> {
  const result: DiscoveredSkill[] = [];
  const canonicalRoot = await realpath(root).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (!canonicalRoot) return result;
  const rootPath: string = canonicalRoot;
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      const actual = await realpath(directory);
      const path = relative(rootPath, actual);
      if (path.startsWith('..') || isAbsolute(path)) return;
      result.push({
        id: basename(directory),
        group: dirname(relative(root, directory)).replace(/^\.$/, ''),
        path: directory,
      });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.'))
        await visit(resolve(directory, entry.name));
    }
  }
  await visit(resolve(root));
  return result;
}

export async function discoverPersonalSkills(root: string, userId: string) {
  const [global, personal] = await Promise.all([
    discover(resolve(root, '.agents', 'skills')),
    discover(resolve(userDirectory(root, userId), '.agents', 'skills')),
  ]);
  return [
    ...new Map(
      [...global, ...personal].map((skill) => [skill.id, skill]),
    ).values(),
  ];
}

export async function discoverProjectSkills(root: string, projectId: string) {
  const [global, project] = await Promise.all([
    discover(resolve(root, '.agents', 'skills')),
    discover(resolve(projectDirectory(root, projectId), '.agents', 'skills')),
  ]);
  return [
    ...new Map(
      [...global, ...project].map((skill) => [skill.id, skill]),
    ).values(),
  ];
}

// Native I/O keeps the terminal, tools and file manager coherent through the same mount.
class MountedAgentFilesystem extends LocalFilesystem {
  constructor(
    directory: string,
    private database: string,
    private mounts: AgentFSMounts,
  ) {
    super({ basePath: directory, contained: true });
  }
  override async init() {
    await this.mounts.ensure(this.basePath, this.database);
    await super.init();
  }
}

class ProjectCompositeFilesystem extends CompositeFilesystem {
  override async init() {
    this.status = 'initializing';
    try {
      // Mastra's default init logs mount errors and continues. Project storage
      // must fail closed so a command cannot write underneath a missing mount.
      for (const filesystem of this.mounts.values()) await filesystem.init?.();
      this.status = 'ready';
    } catch (error) {
      this.status = 'error';
      throw error;
    }
  }
}

export function createProjectFilesystem(
  directory: string,
  input: ProjectWorkspace,
  mounts = projectAgentMounts,
): WorkspaceFilesystem {
  const config = projectWorkspaceSchema.parse(input);
  const provider = (type: 'local' | 'agentfs', name = '') => {
    const path = resolve(directory, name || '.');
    return type === 'agentfs'
      ? new MountedAgentFilesystem(
          path,
          `${resolve(directory)}${name ? `-${name}` : ''}.db`,
          mounts,
        )
      : new LocalFilesystem({ basePath: path, contained: true });
  };
  return config.mode === 'simple'
    ? provider(config.provider)
    : new ProjectCompositeFilesystem({
        mounts: Object.fromEntries(
          config.mounts.map((mount) => [
            `/${mount.mountPath}`,
            provider(mount.provider, mount.mountPath),
          ]),
        ),
      });
}

interface AgentMount {
  alive(): boolean | Promise<boolean>;
  stop(): Promise<void>;
}
type MountAgentFS = (
  directory: string,
  database: string,
) => Promise<AgentMount>;

// Mounts are shared by all conversations and HTTP requests until server shutdown.
// Closing one Workspace must never unmount files used by another request.
export class AgentFSMounts {
  private mounts = new Map<
    string,
    { database: string; ready: Promise<AgentMount> }
  >();
  private closing = false;

  constructor(private start: MountAgentFS = mountAgentFS) {}

  async ensure(directory: string, database: string) {
    if (this.closing) throw new Error('AgentFS mount manager is shutting down');
    directory = resolve(directory);
    database = resolve(database);
    let entry = this.mounts.get(directory);
    if (entry && entry.database !== database)
      throw new Error(
        `AgentFS mount already belongs to another database: ${directory}`,
      );
    if (!entry) {
      entry = { database, ready: this.start(directory, database) };
      this.mounts.set(directory, entry);
      const current = entry;
      void entry.ready.catch(() => {
        if (this.mounts.get(directory) === current)
          this.mounts.delete(directory);
      });
    }
    const mount = await entry.ready;
    if (!(await mount.alive()))
      throw new Error(
        `AgentFS mount stopped unexpectedly: ${directory}. Restart the server after checking the mount.`,
      );
  }

  async dispose() {
    this.closing = true;
    const results = await Promise.allSettled(
      [...this.mounts.values()].map(async ({ ready }) => {
        // A failed startup cleans up its own child process.
        const mount = await ready.catch(() => undefined);
        await mount?.stop();
      }),
    );
    this.mounts.clear();
    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length)
      throw new AggregateError(errors, 'Could not unmount AgentFS');
  }
}

export const projectAgentMounts = new AgentFSMounts();

async function initializeAgentDatabase(database: string) {
  // The native SDK can retain its database lock after close(). Use a short-lived
  // process so the OS releases every handle before the mount opens the database.
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const { AgentFSFilesystem } = await import(process.argv[1]); const fs = new AgentFSFilesystem({ path: process.argv[2] }); try { await fs.init(); } finally { await fs.destroy(); }',
      import.meta.resolve('@mastra/agentfs'),
      database,
    ],
    { timeout: 20_000, maxBuffer: 8192 },
  );
}

async function mountAgentFS(
  directory: string,
  database: string,
): Promise<AgentMount> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('AgentFS mounting requires macOS (NFS) or Linux (FUSE)');
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory)
    throw new Error(
      `AgentFS mount directory cannot contain symlinks: ${directory}`,
    );
  if ((await stat(directory)).dev !== (await stat(dirname(directory))).dev)
    throw new Error(
      `AgentFS directory is already mounted by another process: ${directory}`,
    );
  if ((await readdir(directory)).length)
    throw new Error(`AgentFS mount directory must be empty: ${directory}`);
  for (const suffix of ['', '-wal', '-shm']) {
    const info = await lstat(database + suffix).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (info && !info.isFile())
      throw new Error(`Invalid AgentFS database file: ${database + suffix}`);
  }
  await initializeAgentDatabase(database);
  const originalDevice = (await stat(directory)).dev;
  const child: ChildProcess = spawn(
    'agentfs',
    ['mount', '--foreground', '--auto-unmount', database, directory],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let exited = false;
  let failure: Error | undefined;
  const exitedPromise = new Promise<void>((done) => {
    child.once('error', (error) => {
      failure = error;
      exited = true;
      done();
    });
    child.once('exit', (code, signal) => {
      failure ??= new Error(
        `agentfs mount exited (${signal ?? code}): ${output.trim()}`,
      );
      exited = true;
      done();
    });
  });
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8192);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (!exited) child.kill('SIGINT');
      await Promise.race([
        exitedPromise,
        delay(10_000, undefined, { ref: false }),
      ]);
      if (!exited) {
        // --auto-unmount handles FUSE on forced termination; macOS normally exits on SIGINT.
        child.kill('SIGKILL');
        await exitedPromise;
      }
      if ((await stat(directory)).dev !== originalDevice)
        throw new Error(
          `AgentFS could not unmount ${directory}; unmount it before restarting the server`,
        );
    })());
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (exited) throw failure;
      if ((await stat(directory)).dev !== originalDevice) {
        if (exited) throw failure;
        return {
          alive: async () =>
            !exited && (await stat(directory)).dev !== originalDevice,
          stop,
        };
      }
      await Promise.race([delay(50), exitedPromise]);
    }
    throw new Error(
      `Timed out mounting AgentFS at ${directory}: ${output.trim()}`,
    );
  } catch (error) {
    await stop();
    throw new Error(
      `AgentFS mount failed. Install agentfs and enable NFS (macOS) or FUSE (Linux). ${String(error)}`,
      { cause: error },
    );
  }
}
