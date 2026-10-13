import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource, EntityManager } from 'typeorm';
import { Project, ProjectMember } from '@aime/db';
import {
  projectCreateSchema,
  projectGitHubSourceSchema,
} from '@aime/shared/projects';
import {
  cloneGitHubRepository,
  importGitHubProject,
} from '../apps/server/src/modules/projects/github.js';
import { ProjectService } from '../apps/server/src/modules/projects/service.js';
import { ThreadError } from '../apps/server/src/modules/threads/errors.js';
import {
  createProjectFilesystem,
  projectDirectory,
} from '../apps/server/src/modules/threads/workspace.js';
import { previewWorkspaceFile } from '../apps/server/src/modules/files/workspace-files.js';

const git = promisify(execFile);
const source = {
  type: 'github',
  repositoryUrl: 'https://github.com/octocat/Hello-World.git',
} as const;
const projectId = 'github_project01';

test('GitHub inputs normalize HTTPS/shorthand URLs and keep local storage as the default', () => {
  for (const repositoryUrl of [
    'owner/repo',
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    ' https://github.com/owner/repo/ ',
  ]) {
    const parsed = projectCreateSchema.parse({
      name: ' Repo ',
      source: { ...source, repositoryUrl, branch: ' feature/demo ' },
    });
    assert.equal(parsed.name, 'Repo');
    assert.equal(
      parsed.source?.repositoryUrl,
      'https://github.com/owner/repo.git',
    );
    assert.equal(parsed.source?.branch, 'feature/demo');
    assert.deepEqual(parsed.workspace, { mode: 'simple', provider: 'local' });
  }
  assert.equal(
    projectGitHubSourceSchema.parse({ ...source, branch: ' ' }).branch,
    undefined,
  );
  assert.deepEqual(projectCreateSchema.parse({ name: 'Blank' }), {
    name: 'Blank',
    workspace: { mode: 'simple', provider: 'local' },
  });
  for (const workspace of [
    { mode: 'simple', provider: 'agentfs' },
    { mode: 'composite', mounts: [{ provider: 'local', mountPath: 'local' }] },
  ]) {
    assert.equal(
      projectCreateSchema.safeParse({ name: 'Repo', source, workspace })
        .success,
      false,
    );
    assert.equal(
      projectCreateSchema.safeParse({ name: 'Blank', workspace }).success,
      true,
    );
  }
});

test('GitHub validation rejects credentials, other hosts, local paths, traversal and invalid refs', () => {
  for (const repositoryUrl of [
    'http://github.com/owner/repo',
    'https://github.com.evil.test/owner/repo',
    'https://user:secret@github.com/owner/repo',
    'https://github.com:443/owner/repo',
    'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#main',
    'git@github.com:owner/repo.git',
    'file:///tmp/repo',
    '/tmp/repo',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/../repo',
    'https://github.com/owner/%2e%2e',
    'https://github.com/owner\\repo',
    '-upload-pack/repo',
    'owner/.git',
  ])
    assert.equal(
      projectGitHubSourceSchema.safeParse({ ...source, repositoryUrl }).success,
      false,
      repositoryUrl,
    );
  for (const branch of [
    '--upload-pack=evil',
    '../main',
    'a..b',
    'a//b',
    '@',
    '@{1}',
    'a b',
    'a\\b',
    'main.lock',
    '.hidden/main',
    'a?b',
    'a\nb',
  ])
    assert.equal(
      projectGitHubSourceSchema.safeParse({ ...source, branch }).success,
      false,
      branch,
    );
  for (const branch of ['main', 'feature/demo', 'v1.2.3'])
    assert.equal(
      projectGitHubSourceSchema.safeParse({ ...source, branch }).success,
      true,
      branch,
    );
});

test('a real Git checkout lands in the project root, preserves history and is readable by the workspace', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-github-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'fixture');
  await git('git', ['init', '--initial-branch=main', repository]);
  await writeFile(join(repository, 'README.md'), '# Main branch\n');
  await git('git', ['-C', repository, 'add', '.']);
  await git('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'Initial',
  ]);
  await git('git', ['-C', repository, 'checkout', '-b', 'feature/demo']);
  await writeFile(join(repository, 'README.md'), '# Selected branch\n');
  await git('git', [
    '-C',
    repository,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-am',
    'Feature',
  ]);
  await importGitHubProject(
    root,
    projectId,
    { ...source, branch: 'feature/demo' },
    async (input, directory) => {
      await git('git', [
        '-c',
        'core.hooksPath=/dev/null',
        'clone',
        '--branch',
        input.branch!,
        '--',
        repository,
        directory,
      ]);
    },
  );
  const directory = projectDirectory(root, projectId);
  assert.equal(
    await readFile(join(directory, 'README.md'), 'utf8'),
    '# Selected branch\n',
  );
  assert.equal(
    (
      await git('git', ['-C', directory, 'branch', '--show-current'])
    ).stdout.trim(),
    'feature/demo',
  );
  assert.equal(
    (
      await git('git', ['-C', directory, 'rev-list', '--count', 'HEAD'])
    ).stdout.trim(),
    '2',
  );
  const filesystem = createProjectFilesystem(directory, {
    mode: 'simple',
    provider: 'local',
  });
  await filesystem.init?.();
  t.after(() => filesystem.destroy?.());
  assert.equal(
    (await previewWorkspaceFile(filesystem, 'README.md')).text,
    '# Selected branch\n',
  );
});

test('clone failure removes partial files and never overwrites existing directories or symlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-github-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      importGitHubProject(
        root,
        projectId,
        source,
        async (_source, directory) => {
          await writeFile(join(directory, 'partial'), 'partial');
          throw new ThreadError('PROJECT_CLONE_FAILED', 502);
        },
      ),
    /PROJECT_CLONE_FAILED/,
  );
  assert.deepEqual(await readdir(join(root, 'projects')), []);
  const directory = projectDirectory(root, projectId);
  await mkdir(directory);
  await writeFile(join(directory, 'keep'), 'keep');
  let invoked = false;
  const clone = async () => {
    invoked = true;
  };
  await assert.rejects(
    () => importGitHubProject(root, projectId, source, clone),
    { code: 'EEXIST' },
  );
  assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'keep');
  const linkedId = 'github_project02';
  await symlink(directory, projectDirectory(root, linkedId));
  await assert.rejects(
    () => importGitHubProject(root, linkedId, source, clone),
    { code: 'EEXIST' },
  );
  assert.equal(invoked, false);
});

test('a symlinked projects parent is rejected before cloning', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-github-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'other'));
  await symlink(join(root, 'other'), join(root, 'projects'));
  await assert.rejects(
    () =>
      importGitHubProject(root, projectId, source, async () => {
        assert.fail('must not clone');
      }),
    /WORKSPACE_UNAVAILABLE/,
  );
  assert.deepEqual(await readdir(join(root, 'other')), []);
});

function databaseFixture(failCommit = false) {
  const rows: Array<Project | ProjectMember> = [];
  let transactions = 0;
  const manager = {
    create(entity: typeof Project | typeof ProjectMember, data: object) {
      return Object.assign(new entity(), data);
    },
    async save(_entity: unknown, row: Project | ProjectMember) {
      Object.assign(row, {
        createdAt: new Date(),
        updatedAt: new Date(),
        archived: false,
      });
      rows.push(row);
      return row;
    },
  };
  const database = {
    async transaction<T>(action: (manager: EntityManager) => Promise<T>) {
      transactions++;
      const result = await action(manager as unknown as EntityManager);
      if (failCommit) {
        rows.length = 0;
        throw new Error('database commit failed');
      }
      return result;
    },
  } as DataSource;
  return { database, rows, transactions: () => transactions };
}

test('project and owner are persisted only after clone succeeds, with normalized source metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-github-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = databaseFixture();
  const service = new ProjectService(fixture.database, {
    workspaceRoot: root,
    cloneRepository: async (input, directory) => {
      assert.equal(fixture.transactions(), 0);
      assert.equal(input.repositoryUrl, source.repositoryUrl);
      await writeFile(join(directory, 'README.md'), 'cloned');
    },
  });
  const project = await service.create('alice', { name: 'Imported', source });
  assert.equal(project.role, 'owner');
  assert.deepEqual(project.workspace, { mode: 'simple', provider: 'local' });
  assert.deepEqual(project.source, source);
  assert.equal(fixture.rows.length, 2);
  assert.deepEqual((fixture.rows[0] as Project).metadata, {
    workspace: project.workspace,
    source,
  });
  assert.equal((fixture.rows[1] as ProjectMember).userId, 'alice');
  assert.equal(
    await readFile(
      join(projectDirectory(root, project.id), 'README.md'),
      'utf8',
    ),
    'cloned',
  );
});

test('database failure rolls back cloned files; clone failure never opens a transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-github-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const failed = databaseFixture(true);
  await assert.rejects(
    () =>
      new ProjectService(failed.database, {
        workspaceRoot: root,
        cloneRepository: async (_source, directory) => {
          await writeFile(join(directory, 'README.md'), 'cloned');
        },
      }).create('alice', { name: 'Failed', source }),
    /database commit failed/,
  );
  assert.deepEqual(await readdir(join(root, 'projects')), []);
  const unstarted = databaseFixture();
  await assert.rejects(
    () =>
      new ProjectService(unstarted.database, {
        workspaceRoot: root,
        cloneRepository: async () => {
          throw new ThreadError('PROJECT_CLONE_FAILED', 502);
        },
      }).create('alice', { name: 'Failed', source }),
    /PROJECT_CLONE_FAILED/,
  );
  assert.equal(unstarted.transactions(), 0);
  assert.deepEqual(await readdir(join(root, 'projects')), []);
  await new ProjectService(unstarted.database).create('alice', {
    name: 'Blank',
  });
  assert.equal(unstarted.transactions(), 1);
});

test('missing Git is reported without exposing process or repository details', async () => {
  const previous = process.env.PATH;
  process.env.PATH = '/nonexistent-project-git';
  try {
    await assert.rejects(() => cloneGitHubRepository(source, '/unused'), {
      code: 'PROJECT_GIT_UNAVAILABLE',
      status: 503,
    });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test(
  'live public GitHub clone uses the production transport and keeps origin metadata',
  { skip: process.env.TEST_GITHUB_PROJECT !== '1' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'project-github-live-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await importGitHubProject(root, projectId, source);
    const directory = projectDirectory(root, projectId);
    assert.match(
      await readFile(join(directory, 'README'), 'utf8'),
      /Hello World/i,
    );
    assert.equal(
      (
        await git('git', ['-C', directory, 'remote', 'get-url', 'origin'])
      ).stdout.trim(),
      source.repositoryUrl,
    );
    assert.equal(
      (
        await git('git', ['-C', directory, 'status', '--porcelain'])
      ).stdout.trim(),
      '',
    );
  },
);
