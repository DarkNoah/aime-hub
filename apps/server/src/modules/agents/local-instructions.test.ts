import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { Auth } from '@aime/auth';
import { localAgentFileReference } from '@aime/shared/agents';
import { createApp } from '../../app.js';
import type { ProjectService } from '../projects/service.js';
import { LocalAgentService } from './local-service.js';
import type { AgentService } from './service.js';

test('prompt edits preserve existing Markdown headers and scope and change the runtime version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectId = 'project123456789';
  const project = { scope: 'project', projectId } as const;
  const global = { scope: 'global' } as const;
  const personal = { scope: 'personal' } as const;
  const alice = { userId: 'alice', isAdmin: false };
  const admin = { userId: 'admin', isAdmin: true };
  const projects = {
    assertMember: async (userId: string) => ({
      role: userId === 'member' ? 'member' : 'owner',
    }),
  } as Pick<ProjectService, 'assertMember'>;
  const service = new LocalAgentService(root, projects);
  const filename = 'review:v2.md';
  const header =
    '\uFEFF---\r\n# Legacy file\r\nname: "Reviewer"\r\nextra: keep\r\n---  \r\n';
  for (const [actor, target, path, id] of [
    [admin, global, '.agents/agents', 'local:global:review:v2'],
    [alice, personal, 'users/alice/.agents/agents', 'local:personal:review:v2'],
    [
      alice,
      project,
      `projects/${projectId}/.agents/agents`,
      `local:project:${projectId}:review:v2`,
    ],
  ] as const) {
    assert.deepEqual(localAgentFileReference(id), { target, filename });
    await mkdir(join(root, path), { recursive: true });
    const file = join(root, path, filename);
    await writeFile(file, header + 'First prompt.\r\n');
    const original = await service.getInstructions(actor, target, filename);
    assert.equal(original.instructions, 'First prompt.\r\n');
    const scope = {
      userId: actor.userId,
      projectId: target.scope === 'project' ? projectId : undefined,
    };
    assert.equal(
      (await service.resolve(id, scope)).versionId,
      original.version,
    );
    const patch = {
      filename,
      version: original.version,
      instructions: 'Next prompt.\n---\nMore.',
    };
    await assert.rejects(
      service.updateInstructions(actor, target, {
        ...patch,
        instructions: '  ',
      }),
      { code: 'VALIDATION_ERROR' },
    );
    if (target.scope === 'global')
      await assert.rejects(service.updateInstructions(alice, target, patch), {
        code: 'FORBIDDEN',
      });
    if (target.scope === 'project') {
      const member = { userId: 'member', isAdmin: false };
      assert.equal(
        (await service.getInstructions(member, target, filename)).canManage,
        false,
      );
      await assert.rejects(service.updateInstructions(member, target, patch));
    }
    await service.updateInstructions(actor, target, patch);
    await assert.rejects(service.updateInstructions(actor, target, patch), {
      code: 'AGENT_CONFLICT',
    });
    const runtime = await service.resolve(id, scope);
    assert.notEqual(runtime.versionId, original.version);
    assert.equal(runtime.instructions, 'Next prompt.\r\n---\r\nMore.');
    assert.equal(await readFile(file, 'utf8'), header + runtime.instructions);
  }
  for (const id of [
    'local:global:../oops',
    'local:project:invalid:worker',
    'default',
  ])
    assert.equal(localAgentFileReference(id), undefined);
});

test('the prompt RPC reads and saves the authenticated user’s existing file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'room-prompt-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = 'https://room.example';
  const local = new LocalAgentService(root);
  const auth = {
    api: { getSession: async () => ({ user: { id: 'alice' } }) },
  } as unknown as Auth;
  const app = createApp(
    auth,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { service: {} as AgentService, local, webOrigin: origin },
  );
  const path = join(root, 'users/alice/.agents/agents');
  await mkdir(path, { recursive: true });
  const header = '---\nname: Reviewer\n---\n';
  await writeFile(join(path, 'reviewer.md'), header + 'Review.');
  const file = { target: { scope: 'personal' }, filename: 'reviewer.md' };
  const rpc = (name: string, input: unknown) =>
    app.request(`/api/rpc/localAgents/${name}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ json: input }),
    });
  const read = await rpc('getInstructions', { query: file });
  assert.equal(read.status, 200);
  const { json: source } = await read.json();
  assert.equal(source.instructions, 'Review.');
  const patch = {
    body: { ...file, version: source.version, instructions: 'Cite sources.' },
  };
  assert.equal((await rpc('updateInstructions', patch)).status, 200);
  assert.equal(
    await readFile(join(path, file.filename), 'utf8'),
    header + 'Cite sources.',
  );
  assert.equal((await rpc('updateInstructions', patch)).status, 409);
});
