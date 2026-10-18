import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { buildAgent } from '../../mastra/agents/factory.js';
import { getAgent } from '../../mastra/agents/index.js';
import { loadLocalAgents, parseLocalAgent } from './local.js';

const markdown = (name: string, enabled?: boolean) =>
  `---\nname: ${name}\ndescription: "Review: local files"\n${enabled === undefined ? '' : `enabled: ${enabled}\n`}---\n<instructions> ${name} </instructions>\n`;

async function fixture(t: TestContext) {
  const root = await mkdtemp('/tmp/local-agents-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path: string, content: string) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    return target;
  };
  return { root, put };
}

test('YAML metadata defaults enabled to true and preserves body independently of the display name', () => {
  const config = parseLocalAgent('reviewer', markdown('审查助手'))!;
  assert.equal(config.id, 'reviewer');
  assert.equal(config.name, '审查助手');
  assert.equal(config.description, 'Review: local files');
  assert.equal(
    config.instructions,
    '<instructions> 审查助手 </instructions>\n',
  );
  assert.equal(config.model, null);
  assert.deepEqual(config.agents, {});
  assert.ok(parseLocalAgent('reviewer', markdown('Review', true)));
  assert.equal(parseLocalAgent('reviewer', markdown('Review', false)), null);
  assert.equal(
    parseLocalAgent('reviewer', '---\nname: Off\nenabled: false\n---'),
    null,
  );
  assert.equal(
    parseLocalAgent(
      'reviewer',
      '\uFEFF---\r\nname: Review\r\ndescription: >\r\n  First line\r\n  second line\r\n---\r\nBody',
    )?.description,
    'First line second line',
  );
});

test('rejects malformed YAML, executable frontmatter, invalid enabled values and empty instructions', () => {
  for (const content of [
    'No frontmatter',
    '---\nname: Test\nBody without a closing delimiter',
    '---\nname: [\n---\nBody',
    '---js\n({name: "Test"})\n---\nBody',
    '---javascript\n({name: "Test"})\n---\nBody',
    '---\nname: Test\nenabled: "false"\n---\nBody',
    '---\nname: Test\n---\n  ',
  ])
    assert.throws(() => parseLocalAgent('reviewer', content));
  assert.throws(() => parseLocalAgent('../escape', markdown('Test')));
});

test('loads global plus personal or project files with scoped overrides and disabled masks', async (t) => {
  const { root, put } = await fixture(t);
  const global = '.agents/agents';
  const personal = 'users/alice/.agents/agents';
  const project = 'projects/project123456789/.agents/agents';
  await put(`${global}/shared.md`, markdown('Global'));
  await put(`${global}/override.md`, markdown('Global override'));
  await put(`${global}/disabled.md`, markdown('Global disabled', false));
  await put(`${global}/masked.md`, markdown('Global masked'));
  await put(`${personal}/override.md`, markdown('Personal override'));
  await put(`${personal}/personal.md`, markdown('Personal'));
  await put(`${personal}/masked.md`, markdown('Personal disabled', false));
  await put(`${project}/override.md`, markdown('Project override'));
  await put(`${project}/project.md`, markdown('Project'));
  await put('users/bob/.agents/agents/private.md', markdown('Bob private'));
  await put(
    'projects/another123456789/.agents/agents/private.md',
    markdown('Other project'),
  );
  const personalAgents = await loadLocalAgents(root, 'alice');
  assert.deepEqual(Object.keys(personalAgents).sort(), [
    'override',
    'personal',
    'shared',
  ]);
  assert.equal(personalAgents.override.name, 'Personal override');
  const projectAgents = await loadLocalAgents(
    root,
    'alice',
    'project123456789',
  );
  assert.deepEqual(Object.keys(projectAgents).sort(), [
    'masked',
    'override',
    'project',
    'shared',
  ]);
  assert.equal(projectAgents.override.name, 'Project override');
  assert.deepEqual(
    Object.keys(await loadLocalAgents(root, 'new-user')).sort(),
    ['masked', 'override', 'shared'],
  );
});

test('absent directories are empty and invalid scope IDs are rejected', async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await loadLocalAgents(root, 'alice'), {});
  assert.deepEqual(await loadLocalAgents(join(root, 'missing'), 'alice'), {});
  await assert.rejects(loadLocalAgents(root, '../bob'));
  await assert.rejects(loadLocalAgents(root, 'alice', '../project'));
});

test('skips malformed and nested files and does not follow symlinked files or scope ancestors', async (t) => {
  const { root, put } = await fixture(t);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  await put('.agents/agents/good.md', markdown('Good'));
  await put('.agents/agents/bad.md', '---\nname: [\n---\nsecret body');
  await put('.agents/agents/invalid name.md', markdown('Bad filename'));
  await put('.agents/agents/nested/hidden.md', markdown('Nested'));
  const privateFile = await put(
    'users/bob/.agents/agents/private.md',
    markdown('Private'),
  );
  await mkdir(join(root, 'users/alice/.agents'), { recursive: true });
  await symlink(dirname(privateFile), join(root, 'users/alice/.agents/agents'));
  await symlink(privateFile, join(root, '.agents/agents/linked.md'));
  assert.deepEqual(Object.keys(await loadLocalAgents(root, 'alice')), ['good']);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /secret body/);
  await symlink(join(root, 'users/bob'), join(root, 'users/carol'));
  assert.deepEqual(Object.keys(await loadLocalAgents(root, 'carol')), ['good']);
});

test('factory merges local definitions, preserves explicit references and refreshes edits without nested delegation', async (t) => {
  const { root, put } = await fixture(t);
  await put('.agents/agents/reviewer.md', markdown('First'));
  await put('.agents/agents/default.md', markdown('Local default'));
  const model = new MastraLanguageModelV2Mock({});
  const parent = buildAgent(getAgent('default')!, {
    model,
    buildTools: async () => ({}),
    localSubagents: () => loadLocalAgents(root, 'alice'),
  });
  const children = await parent.listAgents();
  assert.equal(children.default.name, getAgent('default')!.name);
  const reviewer = children.reviewer as Agent;
  assert.equal(
    await reviewer.getInstructions(),
    '<instructions> First </instructions>\n',
  );
  assert.equal((await reviewer.getModel()).modelId, model.modelId);
  assert.deepEqual(await reviewer.listAgents(), {});
  await put('.agents/agents/reviewer.md', markdown('Updated'));
  assert.equal((await parent.listAgents()).reviewer.name, 'Updated');
  await put('.agents/agents/reviewer.md', markdown('Updated', false));
  assert.equal((await parent.listAgents()).reviewer, undefined);
  await put('.agents/agents/new.md', markdown('New'));
  assert.equal((await parent.listAgents()).new.name, 'New');
  await rm(join(root, '.agents/agents/new.md'));
  assert.equal((await parent.listAgents()).new, undefined);
});
