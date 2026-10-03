import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '@mastra/core/agent';
import { validateSkillContent } from '@mastra/core/skills';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { directorySkillConfig } from './skill-source.js';
import { listChatSkills } from './skills.js';
import {
  createPersonalWorkspace,
  discoverPersonalSkills,
  getWorkspace,
} from './workspace.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'directory-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSkill(root: string, path: string, content: string) {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), content);
  return directory;
}

const manifest = (description: string, extra = '') =>
  `---\nname: test\ndescription: ${description}\n${extra}---\n# Instructions\n\nKeep this body.\n`;

test('catalog identifies mismatched manifests by directory, preserves overrides and visibility', async (t) => {
  const root = await fixture(t);
  await writeSkill(root, '.agents/skills/test/test1', manifest('Global one'));
  await writeSkill(root, '.agents/skills/test/test2', manifest('Global two'));
  await writeSkill(
    root,
    'users/alice/.agents/skills/personal/test1',
    manifest('Personal one'),
  );
  await writeSkill(
    root,
    '.agents/skills/test/hidden',
    manifest('Internal skill', 'user-invocable: false\n'),
  );
  const projectId = 'project123456789';
  await writeSkill(
    root,
    `projects/${projectId}/.agents/skills/project/test1`,
    manifest('Project one'),
  );

  assert.deepEqual(await listChatSkills(root, 'bob'), [
    { name: 'test1', description: 'Global one', group: 'test' },
    { name: 'test2', description: 'Global two', group: 'test' },
  ]);
  assert.deepEqual(await listChatSkills(root, 'alice'), [
    { name: 'test1', description: 'Personal one', group: 'personal' },
    { name: 'test2', description: 'Global two', group: 'test' },
  ]);
  assert.deepEqual(await listChatSkills(root, 'alice', projectId), [
    { name: 'test1', description: 'Project one', group: 'project' },
    { name: 'test2', description: 'Global two', group: 'test' },
  ]);
});

test('Agent loads directory IDs with original instructions and bundled resources without changing source files', async (t) => {
  const root = await fixture(t);
  const original = manifest(
    'A shared name',
    'license: MIT\nmetadata:\n  version: "1"\n',
  );
  const directory = await writeSkill(
    root,
    '.agents/skills/test/test1',
    original,
  );
  for (const folder of ['references', 'scripts', 'assets'])
    await mkdir(join(directory, folder));
  const reference =
    '---\nname: example\n---\nThis is reference content, not another skill.';
  await writeFile(join(directory, 'references/SKILL.md'), reference);
  await writeFile(join(directory, 'scripts/run.ts'), 'console.log("test1");');
  const asset = Buffer.from([0, 1, 2, 255]);
  await writeFile(join(directory, 'assets/sample.bin'), asset);
  const discovered = await discoverPersonalSkills(root, 'alice');
  const workspace = getWorkspace(
    root,
    'alice',
    await createPersonalWorkspace(root, 'alice'),
    undefined,
    discovered.map((skill) => skill.path),
  );
  t.after(() => workspace.destroy());
  const agent = new Agent({
    id: 'directory-skills-test',
    name: 'Directory skills test',
    instructions: 'Use the configured skills.',
    model: createMockModel({ mockText: 'Unused', version: 'v2' }),
    workspace,
  });
  assert.deepEqual(
    (await agent.listSkills()).map((skill) => skill.name),
    ['test1'],
  );
  const skill = await agent.getSkill('test1');
  assert.ok(skill);
  assert.equal(skill.name, 'test1');
  assert.equal(skill.description, 'A shared name');
  assert.equal(skill.instructions, '# Instructions\n\nKeep this body.');
  assert.equal(skill.license, 'MIT');
  assert.deepEqual(skill.metadata, { version: '1' });
  assert.equal(await agent.getSkill('test'), null);
  assert.equal(
    await workspace.skills!.getReference('test1', 'references/SKILL.md'),
    reference,
  );
  assert.equal(
    await workspace.skills!.getScript('test1', 'scripts/run.ts'),
    'console.log("test1");',
  );
  assert.deepEqual(
    await workspace.skills!.getAsset('test1', 'assets/sample.bin'),
    asset,
  );
  assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), original);
});

test('normalization only replaces identity and retains validation of other metadata', async (t) => {
  const root = await fixture(t);
  const directory = await writeSkill(
    root,
    '.agents/skills/test1',
    '---\nname: "Some Display Name"\ndescription: >-\n  Multi-line\n  description\n---\nBody',
  );
  const source = directorySkillConfig([directory]).skillSource;
  const normalized = validateSkillContent({
    content: String(await source.readFile(join(directory, 'SKILL.md'))),
    directoryName: 'test1',
  });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.metadata?.name, 'test1');
  assert.equal(normalized.metadata?.description, 'Multi-line description');
  await writeFile(join(directory, 'SKILL.md'), '---\nname: test\n---\nBody');
  const invalid = validateSkillContent({
    content: String(await source.readFile(join(directory, 'SKILL.md'))),
    directoryName: 'test1',
  });
  assert.equal(invalid.valid, false);
  assert.ok(
    invalid.errors.some((error) => error.toLowerCase().includes('description')),
  );
});
