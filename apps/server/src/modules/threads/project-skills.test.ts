import assert from 'node:assert/strict';
import test from 'node:test';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import {
  discoverInstalledSkills,
  getWorkspace,
  createPersonalWorkspace,
} from './workspace.js';
import { listChatSkills, resolveAgentSkillPaths } from './skills.js';
import { projectSharedSkillsRoot } from '../skills/share-links.js';

const manifest = (description: string) =>
  `---\nname: upstream-name\ndescription: ${description}\n---\nRead references/setup.md and run setup from the project root.\n`;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'project-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root: string, path: string, content: string) {
  const filename = join(root, path);
  await mkdir(join(filename, '..'), { recursive: true });
  await writeFile(filename, content);
  return filename;
}

async function project(
  root: string,
  repo: string,
  entries: Array<{ path: string; name: string }>,
  options: { archive?: boolean; legacy?: boolean } = {},
) {
  const group = join(
    root,
    '.agents/skills',
    options.archive ? '' : 'demo',
    repo,
  );
  const projectRoot = options.legacy ? join(group, 'project') : group;
  for (const entry of entries)
    await write(projectRoot, entry.path, manifest(entry.name));
  await write(
    group,
    options.legacy ? '.skill-project.json' : '.skill-meta/.skill-project.json',
    JSON.stringify({
      version: options.legacy ? 1 : 2,
      root: options.legacy ? 'project' : '.',
      entries,
    }),
  );
  return projectRoot;
}

test('whole projects load selected original paths, stable names, shared code and native resources', async (t) => {
  const root = await fixture(t);
  const projectRoot = await project(root, 'rea-toon', [
    { path: 'skills/REA_Toon/SKILL.md', name: 'rea-toon' },
    { path: '.claude/skills/Hidden/SKILL.md', name: 'hidden' },
  ]);
  const directory = join(projectRoot, 'skills/REA_Toon');
  await write(projectRoot, 'rea_toon/__init__.py', 'VERSION = "1"');
  await write(projectRoot, 'pyproject.toml', '[project]\nname = "rea-toon"');
  await write(projectRoot, 'skills/unused/SKILL.md', manifest('Unused'));
  await write(
    projectRoot,
    'skills/REA_Toon/references/setup.md',
    'pip install -e ../..',
  );
  await write(
    projectRoot,
    'skills/REA_Toon/references/SKILL.md',
    'A reference, not an entry.',
  );
  await write(projectRoot, 'skills/REA_Toon/scripts/run.py', 'print("ready")');
  await write(projectRoot, 'skills/REA_Toon/assets/sample.txt', 'asset');
  const rootProject = await project(root, 'root-skill', [
    { path: 'SKILL.md', name: 'root-skill' },
  ]);
  const discovered = await discoverInstalledSkills(root, 'alice');
  assert.deepEqual(
    discovered.map(({ id, group }) => ({ id, group })),
    [
      { id: 'rea-toon', group: 'demo/rea-toon' },
      { id: 'hidden', group: 'demo/rea-toon' },
      { id: 'root-skill', group: 'demo/root-skill' },
    ],
  );
  assert.deepEqual(
    (await listChatSkills(root, 'alice')).map(({ name }) => name),
    ['hidden', 'rea-toon', 'root-skill'],
  );
  const paths = await resolveAgentSkillPaths(root, 'alice', {
    source: 'code',
    skillsMode: 'auto',
    skillPaths: [],
  });
  assert.ok(paths.includes(directory));
  const workspace = getWorkspace(
    root,
    'alice',
    await createPersonalWorkspace(root, 'alice'),
    undefined,
    async () => paths,
  );
  t.after(() => workspace.destroy());
  assert.equal((await workspace.skills!.get(directory))?.name, 'rea-toon');
  const agent = new Agent({
    id: 'project-test',
    name: 'Project test',
    instructions: 'Use skills',
    model: createMockModel({ mockText: 'Unused', version: 'v2' }),
    workspace,
  });
  assert.deepEqual((await agent.listSkills()).map(({ name }) => name).sort(), [
    'hidden',
    'rea-toon',
    'root-skill',
  ]);
  const skill = await agent.getSkill('rea-toon');
  assert.ok(skill);
  assert.equal(skill.path, directory);
  assert.ok(skill.instructions.includes(JSON.stringify(projectRoot)));
  assert.ok(skill.instructions.includes('Read references/setup.md'));
  assert.equal((await agent.getSkill('root-skill'))?.path, rootProject);
  assert.equal((await workspace.skills!.get(directory))?.name, 'rea-toon');
  assert.equal(
    (await workspace.skills!.get(join(directory, 'SKILL.md')))?.name,
    'rea-toon',
  );
  assert.equal(
    await workspace.skills!.getReference('rea-toon', 'references/setup.md'),
    'pip install -e ../..',
  );
  assert.equal(
    await workspace.skills!.getReference(directory, 'references/SKILL.md'),
    'A reference, not an entry.',
  );
  assert.equal(
    await workspace.skills!.getScript('rea-toon', 'scripts/run.py'),
    'print("ready")',
  );
  assert.equal(
    (
      await workspace.skills!.getAsset('rea-toon', 'assets/sample.txt')
    )?.toString(),
    'asset',
  );
  const search = await workspace.skills!.search('pip install');
  assert.ok(
    search.some((result) => result.skillPath === directory),
    JSON.stringify(search),
  );
  assert.ok(
    search.every((result) => !result.skillPath.includes('.skill-entry')),
  );
  assert.equal(
    await readFile(join(directory, 'SKILL.md'), 'utf8'),
    manifest('rea-toon'),
  );
  assert.equal(
    await readFile(join(projectRoot, 'rea_toon/__init__.py'), 'utf8'),
    'VERSION = "1"',
  );
  const scoped = await workspace.skills!.getScoped!({
    requestContext: new RequestContext(),
  });
  assert.equal((await scoped.get('rea-toon'))?.path, directory);
  await workspace.destroy();
  await assert.rejects(scoped.list());
});

test('project entries participate in personal overrides and exact custom selections', async (t) => {
  const root = await fixture(t);
  const global = await project(root, 'one', [
    { path: 'skills/shared/SKILL.md', name: 'shared' },
  ]);
  await project(join(root, 'users/alice'), 'two', [
    { path: 'SKILL.md', name: 'shared' },
  ]);
  const bob = await listChatSkills(root, 'bob');
  const alice = await listChatSkills(root, 'alice');
  assert.equal(bob[0].group, 'demo/one');
  assert.equal(alice[0].group, 'demo/two');
  assert.deepEqual(
    await resolveAgentSkillPaths(root, 'alice', {
      source: 'database',
      skillsMode: 'custom',
      skillPaths: ['demo/one/skills/shared'],
    }),
    [join(global, 'skills/shared')],
  );
});

test('project discovery rejects malformed or symlinked entries and ignores unselected manifests', async (t) => {
  const root = await fixture(t);
  const projectRoot = await project(root, 'safe', [
    { path: 'selected/SKILL.md', name: 'selected' },
  ]);
  await write(projectRoot, 'other/.skill-project.json', '{}');
  await write(projectRoot, 'other/SKILL.md', manifest('unselected'));
  assert.equal((await discoverInstalledSkills(root)).length, 1);
  await rm(join(projectRoot, 'selected/SKILL.md'));
  await symlink(
    join(projectRoot, 'other/SKILL.md'),
    join(projectRoot, 'selected/SKILL.md'),
  );
  await assert.rejects(discoverInstalledSkills(root), /SKILL_PROJECT_INVALID/);
});

test('single-level archive projects load root and hidden entries alongside legacy installations', async (t) => {
  const root = await fixture(t);
  const local = await project(
    root,
    'local-project',
    [{ path: '.agents/skills/Local_Name/SKILL.md', name: 'local-entry' }],
    { archive: true },
  );
  const localRoot = await project(
    root,
    'root-project',
    [{ path: 'SKILL.md', name: 'root-entry' }],
    { archive: true },
  );
  const legacy = await project(
    root,
    'legacy',
    [{ path: 'skills/legacy/SKILL.md', name: 'legacy' }],
    { legacy: true },
  );
  // Source files may use the old metadata names; hidden v2 records take precedence.
  await write(local, '.skill-project.json', '{"upstream": true}');
  await write(local, '.skill-sources.json', '{"upstream": true}');
  await write(
    local,
    'unselected/.skill-meta/.skill-project.json',
    '{"not": "app metadata"}',
  );
  await write(local, 'unselected/SKILL.md', manifest('unselected'));
  assert.deepEqual(
    (await listChatSkills(root, 'alice')).map(({ name, group }) => ({
      name,
      group,
    })),
    [
      { name: 'legacy', group: 'demo/legacy' },
      { name: 'local-entry', group: 'local-project' },
      { name: 'root-entry', group: 'root-project' },
    ],
  );
  const paths = await resolveAgentSkillPaths(root, 'alice', {
    source: 'database',
    skillsMode: 'custom',
    skillPaths: [
      'local-project/.agents/skills/Local_Name',
      'root-project',
      'demo/legacy/project/skills/legacy',
    ],
  });
  assert.deepEqual(paths, [
    join(local, '.agents/skills/Local_Name'),
    localRoot,
    join(legacy, 'skills/legacy'),
  ]);
  const workspace = getWorkspace(
    root,
    'alice',
    await createPersonalWorkspace(root, 'alice'),
    undefined,
    paths,
  );
  t.after(() => workspace.destroy());
  for (const [name, projectRoot] of [
    ['local-entry', local],
    ['root-entry', localRoot],
    ['legacy', legacy],
  ]) {
    const skill = await workspace.skills!.get(name);
    assert.ok(skill);
    assert.ok(skill.instructions.includes(JSON.stringify(projectRoot)));
    assert.ok(!skill.path.includes('.skill-entry'));
  }
});

async function share(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await symlink(relative(dirname(destination), source), destination);
}

test('project chat discovers only published packages and reads selected current and legacy project entries via shared paths', async (t) => {
  const root = await fixture(t);
  const id = 'project000000001';
  const owner = join(root, 'users/alice');
  const personal = join(owner, '.agents/skills');
  const shared = projectSharedSkillsRoot(root, id);
  const local = join(root, 'projects', id, '.agents/skills');
  await write(personal, 'plain/SKILL.md', manifest('plain'));
  await write(personal, 'unpublished/SKILL.md', manifest('unpublished'));
  await share(join(personal, 'plain'), join(root, '.agents/skills/plain'));
  // Links in a user-writable project workspace never confer a share.
  await share(join(personal, 'unpublished'), join(local, 'unpublished'));
  for (const legacy of [false, true]) {
    const name = legacy ? 'legacy' : 'current';
    const contents = await project(
      owner,
      name,
      [{ path: 'skills/Selected/SKILL.md', name }],
      { legacy },
    );
    await write(
      contents,
      'skills/NotSelected/SKILL.md',
      manifest('unselected'),
    );
    await write(contents, 'skills/Selected/references/steps.md', 'Original');
    await share(join(personal, 'demo', name), join(shared, 'demo', name));
  }
  assert.deepEqual(
    (await listChatSkills(root, 'bob')).map((skill) => skill.name),
    ['plain'],
  );
  assert.deepEqual(
    (await listChatSkills(root, 'bob', 'project000000002')).map(
      (skill) => skill.name,
    ),
    ['plain'],
  );
  const catalog = await listChatSkills(root, 'bob', id, async (ids) => {
    assert.deepEqual(ids, ['alice']);
    return new Map([['alice', 'Alice']]);
  });
  assert.deepEqual(
    catalog.map(({ name, sourceUserName }) => [name, sourceUserName]),
    [
      ['current', 'Alice'],
      ['legacy', 'Alice'],
      ['plain', 'Alice'],
    ],
  );
  const paths = await resolveAgentSkillPaths(
    root,
    'bob',
    { source: 'code', skillsMode: 'auto', skillPaths: [] },
    id,
  );
  const workspace = getWorkspace(
    root,
    'bob',
    join(root, 'projects', id),
    id,
    paths,
  );
  t.after(() => workspace.destroy());
  await assert.rejects(
    workspace.filesystem!.readFile(join(personal, 'unpublished/SKILL.md')),
  );
  const current = await workspace.skills!.get('current');
  assert.equal(current?.path, join(shared, 'demo/current/skills/Selected'));
  assert.ok(
    current?.instructions.includes(
      JSON.stringify(join(shared, 'demo/current')),
    ),
  );
  assert.equal(
    await workspace.skills!.getReference('legacy', 'references/steps.md'),
    'Original',
  );
  await write(
    personal,
    'demo/legacy/project/skills/Selected/references/steps.md',
    'Edited',
  );
  assert.equal(
    await workspace.skills!.getReference('legacy', 'references/steps.md'),
    'Edited',
  );
  assert.equal(await workspace.skills!.get('unpublished'), null);
  assert.equal(await workspace.skills!.get('NotSelected'), null);
  assert.deepEqual(
    await resolveAgentSkillPaths(
      root,
      'bob',
      { source: 'database', skillsMode: 'custom', skillPaths: ['plain'] },
      id,
    ),
    [join(root, '.agents/skills/plain')],
  );
});

test('shared skill reads reject linked resources, invalid installation targets and cached entries after unsharing', async (t) => {
  const root = await fixture(t);
  const from = join(root, 'users/alice/.agents/skills');
  const global = join(root, '.agents/skills');
  await write(from, 'collection/private/SKILL.md', manifest('private'));
  await write(from, 'open/SKILL.md', manifest('open'));
  const outside = await write(
    from,
    'collection/private/references/note.md',
    'Private note',
  );
  await write(from, 'open/references/public.md', 'Public note');
  await symlink(outside, join(from, 'open/references/symbolic'));
  await link(outside, join(from, 'open/references/hard'));
  await symlink(dirname(outside), join(from, 'open/references/directory'));
  await share(join(from, 'collection'), join(global, 'collection'));
  await share(join(from, 'collection/private'), join(global, 'wrong-location'));
  await share(join(from, 'open'), join(global, 'open'));
  assert.deepEqual(
    (await listChatSkills(root, 'bob')).map(({ name, sourceUserName }) => [
      name,
      sourceUserName,
    ]),
    [['open', 'alice']],
  );
  const workspace = getWorkspace(
    root,
    'bob',
    await createPersonalWorkspace(root, 'bob'),
    undefined,
    [join(global, 'open')],
  );
  t.after(() => workspace.destroy());
  const scoped = await workspace.skills!.getScoped!({
    requestContext: new RequestContext(),
  });
  assert.equal((await scoped.get('open'))?.path, join(global, 'open'));
  assert.equal(
    await scoped.getReference('open', 'references/public.md'),
    'Public note',
  );
  assert.deepEqual(await scoped.listReferences('open'), ['public.md']);
  for (const resource of ['symbolic', 'hard', 'directory/note.md'])
    assert.equal(
      await scoped.getReference('open', `references/${resource}`),
      null,
    );
  await rm(join(global, 'open'));
  assert.deepEqual(await scoped.list(), []);
  await assert.rejects(scoped.get('open'), /SKILL_SHARE_UNAVAILABLE/);
  await assert.rejects(
    scoped.getReference('open', 'references/public.md'),
    /SKILL_SHARE_UNAVAILABLE/,
  );
  const next = join(root, 'users/carol/.agents/skills/open');
  await write(next, 'SKILL.md', manifest('Next publisher'));
  await share(next, join(global, 'open'));
  assert.equal(
    (await workspace.skills!.get('open'))?.description,
    'Next publisher',
  );
  await assert.rejects(scoped.get('open'), /SKILL_SHARE_UNAVAILABLE/);
});
