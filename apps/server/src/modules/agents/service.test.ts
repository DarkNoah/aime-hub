import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';
import { Setting } from '@aime/db';
import { agentSettingsStore } from './settings.js';
import { LanguageModelService } from '../models/language-model.js';
import type { ProviderService } from '../providers/service.js';
import type { AgentSettingsStore } from './settings.js';
import { fallbackAgentId, getCodeAgent } from '../../mastra/agents/index.js';
import { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { buildTools } from '../tools/service.js';
import { InMemoryStore, type AgentsStorage } from '@mastra/core/storage';
import { PostgresStore } from '@mastra/pg';
import {
  agentInputSchema,
  agentUpdateSchema,
  type AgentDefaults,
  type AgentInput,
} from '@aime/shared/agents';
import type { AvailableModels } from '@aime/shared/providers';
import { webFetchConfigSchema } from '@aime/shared/tools';
import { AgentService } from './service.js';
import { createApp } from '../../app.js';
import { createApiClient } from '../../../../web/src/lib/rpc.js';

const providerId = randomUUID();
const available: AvailableModels = {
  providers: [
    {
      id: providerId,
      name: 'Fixture',
      type: 'openai',
      enabled: true,
      models: [
        {
          id: 'fixture/model',
          providerId,
          name: 'Fixture',
          displayName: null,
          description: null,
          enabled: true,
          modalitiesInput: ['text'],
          modalitiesOutput: ['text'],
          reasoning: false,
          toolCall: true,
          limitContext: null,
          limitOutput: null,
        },
      ],
    },
  ],
};
const input: AgentInput = {
  name: '研究助手',
  description: '资料整理',
  instructions: '  # Role\n请保留空格和换行。\n',
  model: `${providerId}/fixture/model`,
  tools: ['web_fetch', 'ask_user'],
  skillPaths: ['example/research'],
};

function serviceFor(
  store: AgentsStorage,
  listAvailableModels = async (): Promise<AvailableModels> => available,
  settings?: AgentSettingsStore,
) {
  return new AgentService(
    store,
    {
      list: async () => ({
        root: '/synthetic/skills',
        skills: [
          {
            path: 'example/research',
            name: 'research',
            description: 'Research skill',
            group: 'example',
            valid: true,
          },
          {
            path: 'broken',
            name: 'broken',
            description: '',
            group: '',
            valid: false,
          },
        ],
      }),
    },
    {
      list: async () => [
        {
          id: 'web_fetch',
          config: webFetchConfigSchema.parse({ enabled: false }),
        },
      ],
    },
    { listAvailableModels },
    settings,
  );
}

test('agent input rejects unsafe paths, unknown tools, duplicate selections and invalid prompts', () => {
  assert.equal(agentInputSchema.parse(input).instructions, input.instructions);
  assert.equal(agentInputSchema.parse({ ...input, model: null }).model, null);
  for (const patch of [
    { name: ' ' },
    { instructions: '\n ' },
    { instructions: '\0' },
    { instructions: 'x'.repeat(24001) },
    { model: 'invalid' },
    { model: '' },
    { tools: ['invented'] },
    { tools: ['sleep', 'sleep'] },
    { skillPaths: ['../secret'] },
    { skillPaths: ['/absolute'] },
    { skillPaths: ['x\\y'] },
    { skillPaths: ['a//b'] },
    { skillPaths: ['a', 'a'] },
    { enabled: true },
    { id: fallbackAgentId },
  ]) {
    assert.equal(
      agentInputSchema.safeParse({ ...input, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  }
  assert.equal(agentUpdateSchema.safeParse(input).success, false);
  assert.equal(
    agentInputSchema.safeParse({ ...input, tools: [], skillPaths: [] }).success,
    true,
  );
});

test('draft models can be omitted with null, cleared and reassigned without changing old versions', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const withoutProviders = serviceFor(store, async () => {
    throw new Error('Unfixed models must not depend on the provider catalog');
  });
  const created = await withoutProviders.create('admin', {
    ...input,
    model: null,
  });
  assert.equal(created.model, null);
  assert.equal((await withoutProviders.get(created.id)).model, null);
  assert.equal(
    (await withoutProviders.list()).find((row) => row.id === created.id)?.model,
    null,
  );
  assert.deepEqual((await store.getVersion(created.versionId))?.model, []);

  const assigned = await service.update(created.id, {
    ...input,
    versionId: created.versionId,
  });
  assert.equal(assigned.model, input.model);
  const cleared = await withoutProviders.update(created.id, {
    ...input,
    model: null,
    versionId: assigned.versionId,
  });
  assert.equal(cleared.model, null);
  assert.equal(cleared.versionNumber, 3);
  assert.deepEqual((await store.getVersion(cleared.versionId))?.model, []);
  assert.deepEqual((await store.getVersion(assigned.versionId))?.model, {
    provider: 'openai',
    name: 'fixture/model',
    providerId,
  });
  const reassigned = await service.update(created.id, {
    ...input,
    versionId: cleared.versionId,
  });
  assert.equal(reassigned.model, input.model);
  assert.equal(reassigned.versionNumber, 4);
});

test('nonempty native conditional model configurations are not mistaken for an unfixed model', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const created = await service.create('admin', input);
  const version = (await store.getVersion(created.versionId))!;
  await store.createVersion({
    ...version,
    id: randomUUID(),
    versionNumber: 2,
    model: [
      { value: { provider: 'openai', name: 'fixture/model', providerId } },
    ],
  });
  await assert.rejects(service.get(created.id), {
    code: 'AGENT_CONFIG_UNSUPPORTED',
  });
});

test('native agent CRUD preserves prompt and versioned tools/skills, rejects stale writes, and deletes versions', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const created = await service.create('admin', input);
  assert.equal(created.status, 'draft');
  assert.equal(created.versionNumber, 1);
  assert.equal(created.instructions, input.instructions);
  assert.deepEqual(
    (await service.list())
      .filter((row) => row.source === 'database')
      .map((row) => row.id),
    [created.id],
  );
  const version1 = await store.getVersion(created.versionId);
  assert.deepEqual(version1?.tools, { web_fetch: {}, ask_user: {} });
  assert.deepEqual(version1?.workspace, {
    type: 'provider',
    provider: 'installed-skills',
    config: { skillPaths: input.skillPaths },
  });
  assert.deepEqual(version1?.model, {
    provider: 'openai',
    name: 'fixture/model',
    providerId,
  });
  const attempts = await Promise.allSettled([
    service.update(created.id, {
      ...input,
      instructions: 'Changed',
      tools: [],
      skillPaths: [],
      versionId: created.versionId,
    }),
    service.update(created.id, {
      ...input,
      name: 'Stale',
      versionId: created.versionId,
    }),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    attempts.find((result) => result.status === 'rejected')?.reason.code,
    'AGENT_CONFLICT',
  );
  const changed = await service.get(created.id);
  assert.equal(changed.source, 'database');
  if (changed.source !== 'database') assert.fail('Expected stored agent');
  assert.equal(changed.versionNumber, 2);
  assert.equal(changed.name, input.name);
  assert.deepEqual(changed.tools, []);
  assert.deepEqual(changed.skillPaths, []);
  assert.equal(
    (await store.getVersion(created.versionId))?.instructions,
    input.instructions,
  );
  assert.equal((await store.getById(created.id))?.activeVersionId, undefined);
  await assert.rejects(service.remove(created.id, created.versionId), {
    code: 'AGENT_CONFLICT',
  });
  await service.remove(created.id, changed.versionId);
  assert.equal(await store.getById(created.id), null);
  assert.equal(await store.countVersions(created.id), 0);
  await assert.rejects(service.get(created.id), { code: 'AGENT_NOT_FOUND' });
});

test('catalog and validation use available resources without exposing filesystem roots or provider credentials', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const catalog = await service.catalog();
  assert.equal(
    catalog.tools.find((tool) => tool.id === 'web_fetch')?.enabled,
    false,
  );
  assert.equal(catalog.skills.length, 1);
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic/);
  for (const skillPaths of [['missing'], ['broken']])
    await assert.rejects(service.create('admin', { ...input, skillPaths }), {
      code: 'AGENT_SKILL_UNAVAILABLE',
    });
  await assert.rejects(
    service.create('admin', { ...input, model: 'unknown/model' }),
    { code: 'AGENT_MODEL_UNAVAILABLE' },
  );
  assert.equal(
    (await service.list()).filter((row) => row.source === 'database').length,
    0,
  );
});

test('agents created outside administration are neither listed nor mutated', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const id = randomUUID();
  await store.create({
    agent: {
      id,
      name: 'External',
      instructions: 'Keep',
      model: { provider: 'openai', name: 'fixture' },
    },
  });
  assert.deepEqual(
    (await service.list()).map((row) => row.id),
    [fallbackAgentId],
  );
  await assert.rejects(service.get(id), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(
    service.update(id, { ...input, versionId: randomUUID() }),
    { code: 'AGENT_NOT_FOUND' },
  );
  await assert.rejects(service.remove(id, randomUUID()), {
    code: 'AGENT_NOT_FOUND',
  });
  assert.equal((await store.getLatestVersion(id))?.instructions, 'Keep');
});

test('code agents stay outside storage, remain read only, and share defaults with stored agents', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  let saved: AgentDefaults | null = null;
  const settings: AgentSettingsStore = {
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
  };
  const service = serviceFor(store, undefined, settings);
  const builtin = await service.getConfig();
  assert.equal(builtin.id, fallbackAgentId);
  assert.equal(builtin.source, 'code');
  assert.equal(await store.getById(builtin.id), null);
  builtin.name = 'Should not mutate registry';
  assert.notEqual((await service.getConfig()).name, builtin.name);
  await assert.rejects(
    service.update(builtin.id, { ...input, versionId: randomUUID() }),
    { code: 'AGENT_READ_ONLY' },
  );
  await assert.rejects(service.remove(builtin.id, randomUUID()), {
    code: 'AGENT_READ_ONLY',
  });
  const custom = await service.create('admin', { ...input, model: null });
  await service.setStatus(custom.id, {
    status: 'published',
    versionId: custom.versionId,
  });
  await service.setDefaults({ defaultAgentId: custom.id });
  assert.deepEqual(saved, { defaultAgentId: custom.id });
  assert.equal((await service.getConfig()).id, custom.id);
  assert.equal(
    (await serviceFor(store, undefined, settings).getConfig()).id,
    custom.id,
  );
  await assert.rejects(service.remove(custom.id, custom.versionId), {
    code: 'AGENT_IS_DEFAULT',
  });
  const catalog = await service.available();
  assert.equal(catalog.defaultAgentId, custom.id);
  assert.deepEqual(
    catalog.agents.map((agent) => agent.id),
    [fallbackAgentId, custom.id],
  );
  assert.ok(
    catalog.agents.every(
      (agent) => !('instructions' in agent) && !('skillPaths' in agent),
    ),
  );
  await assert.rejects(service.setDefaults({ defaultAgentId: 'missing' }), {
    code: 'AGENT_NOT_FOUND',
  });
  await assert.rejects(service.getConfig('missing'), {
    code: 'AGENT_NOT_FOUND',
  });
  // A stale setting from an external deletion falls back to the built-in agent.
  await store.delete(custom.id);
  assert.equal((await service.getConfig()).id, fallbackAgentId);
});

test('only published stored agents can be selected or constructed and status switches preserve configuration versions', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  let defaults: AgentDefaults | null = null;
  const service = serviceFor(store, undefined, {
    read: async () => defaults,
    write: async (value) => {
      defaults = value;
    },
  });
  const created = await service.create('admin', { ...input, model: null });
  const model = new MastraLanguageModelV2Mock({});
  assert.equal((await service.available()).agents.length, 1);
  for (const lookup of [
    () => service.getConfig(created.id),
    () => service.getAgent(created.id, { model }),
    () => service.setDefaults({ defaultAgentId: created.id }),
  ])
    await assert.rejects(lookup(), { code: 'AGENT_NOT_PUBLISHED' });
  await assert.rejects(
    service.setStatus(fallbackAgentId, {
      status: 'draft',
      versionId: created.versionId,
    }),
    { code: 'AGENT_READ_ONLY' },
  );
  await assert.rejects(
    service.setStatus(created.id, {
      status: 'published',
      versionId: randomUUID(),
    }),
    { code: 'AGENT_CONFLICT' },
  );

  const published = await service.setStatus(created.id, {
    status: 'published',
    versionId: created.versionId,
  });
  assert.equal(published.status, 'published');
  assert.equal(published.versionId, created.versionId);
  assert.equal(await store.countVersions(created.id), 1);
  assert.deepEqual(await service.getConfig(created.id), published);
  assert.equal((await service.available()).agents.length, 2);
  assert.equal((await service.getAgent(created.id, { model })).id, created.id);
  const updated = await service.update(created.id, {
    ...input,
    model: null,
    instructions: 'Published update',
    versionId: created.versionId,
  });
  assert.equal(updated.status, 'published');
  assert.equal(
    (await store.getById(created.id))?.activeVersionId,
    updated.versionId,
  );
  assert.equal(
    await (await service.getAgent(created.id, { model })).getInstructions(),
    'Published update',
  );
  await assert.rejects(
    service.setStatus(created.id, {
      status: 'draft',
      versionId: created.versionId,
    }),
    { code: 'AGENT_CONFLICT' },
  );
  await service.setDefaults({ defaultAgentId: created.id });
  await assert.rejects(
    service.setStatus(created.id, {
      status: 'draft',
      versionId: updated.versionId,
    }),
    { code: 'AGENT_IS_DEFAULT' },
  );
  await service.setDefaults({ defaultAgentId: fallbackAgentId });
  const draft = await service.setStatus(created.id, {
    status: 'draft',
    versionId: updated.versionId,
  });
  assert.equal(draft.status, 'draft');
  assert.equal(await store.countVersions(created.id), 2);
  assert.equal((await service.available()).agents.length, 1);
  await assert.rejects(
    service.getAgent(created.id, { model, versionId: created.versionId }),
    { code: 'AGENT_NOT_PUBLISHED' },
  );

  await service.setStatus(created.id, {
    status: 'published',
    versionId: updated.versionId,
  });
  await service.setDefaults({ defaultAgentId: created.id });
  // A status change outside administration also invalidates the saved default.
  await store.update({ id: created.id, status: 'archived' });
  assert.equal((await service.getDefaults()).defaultAgentId, fallbackAgentId);
  assert.equal((await service.available()).agents.length, 1);
  await assert.rejects(service.getConfig(created.id), {
    code: 'AGENT_NOT_PUBLISHED',
  });
});

test('available agents do not load unsupported draft configurations', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const draft = await service.create('admin', { ...input, model: null });
  const version = (await store.getVersion(draft.versionId))!;
  await store.createVersion({
    ...version,
    id: randomUUID(),
    versionNumber: 2,
    model: [{ value: { provider: 'openai', name: 'fixture', providerId } }],
  });
  assert.equal((await service.available()).agents.length, 1);
  const withStaleDefault = serviceFor(store, undefined, {
    read: async () => ({ defaultAgentId: draft.id }),
    write: async () => {},
  });
  assert.equal(
    (await withStaleDefault.available()).defaultAgentId,
    fallbackAgentId,
  );
  await assert.rejects(withStaleDefault.getConfig(draft.id), {
    code: 'AGENT_NOT_PUBLISHED',
  });
});

test('code IDs are reserved and code lookup wins without reading a conflicting stored configuration', async (t) => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const reserved = { ...input, id: fallbackAgentId };
  await assert.rejects(service.create('admin', reserved), { name: 'ZodError' });
  assert.equal(await store.getById(fallbackAgentId), null);

  // Simulate an external/legacy row; administration cannot create this collision.
  await store.create({
    agent: {
      id: fallbackAgentId,
      name: 'Conflicting stored agent',
      instructions: 'Must never be used',
      model: [],
      metadata: { managedBy: 'admin-agents', configVersion: 1 },
    },
  });
  for (const method of ['getById', 'getLatestVersion', 'getVersion'] as const)
    t.mock.method(store, method, () => {
      throw new Error('A code agent lookup must not read stored configuration');
    });
  const builtin = getCodeAgent(fallbackAgentId)!;
  assert.deepEqual(await service.get(fallbackAgentId), builtin);
  assert.deepEqual(await service.getConfig(fallbackAgentId), builtin);
  assert.deepEqual(await service.list(), [builtin]);
  assert.equal((await service.available()).agents.length, 1);
  const agent = await service.getAgent(fallbackAgentId, {
    model: new MastraLanguageModelV2Mock({}),
    versionId: 'ignored-for-code-agent',
  });
  assert.equal(await agent.getInstructions(), builtin.instructions);
  assert.equal(agent.id, builtin.id);
});

test('getAgent builds a fresh Mastra Agent with runtime dependencies and can pin a stored version', async () => {
  const store = (await new InMemoryStore().getStore('agents'))!;
  const service = serviceFor(store);
  const created = await service.create('admin', {
    ...input,
    tools: ['curr_time'],
    model: null,
  });
  await service.setStatus(created.id, {
    status: 'published',
    versionId: created.versionId,
  });
  const updated = await service.update(created.id, {
    ...input,
    model: null,
    instructions: 'New instructions',
    tools: ['sleep'],
    versionId: created.versionId,
  });
  const model = new MastraLanguageModelV2Mock({});
  const selections: string[][] = [];
  const original = await service.getAgent(created.id, {
    model,
    versionId: created.versionId,
    buildTools: async (ids, defaults) => {
      selections.push([...ids]);
      return buildTools(ids, defaults);
    },
  });
  assert.ok(original instanceof Agent);
  assert.equal(original.id, created.id);
  assert.equal(await original.getInstructions(), input.instructions);
  assert.deepEqual(Object.keys(await original.listTools()), ['curr_time']);
  assert.deepEqual(selections, [['curr_time']]);
  const latest = await service.getAgent(created.id, {
    model,
    instructions: 'Runtime instructions',
    buildTools: async (ids, defaults) => buildTools(ids, defaults),
  });
  assert.equal(await latest.getInstructions(), 'Runtime instructions');
  assert.deepEqual(Object.keys(await latest.listTools()), ['sleep']);
  assert.notEqual(original, latest);
  const disabled = await service.getAgent(created.id, {
    model,
    defaultToolConfigs: { sleep: { enabled: false } },
  });
  assert.deepEqual(await disabled.listTools(), {});
  const other = await service.create('admin', { ...input, model: null });
  await service.setStatus(other.id, {
    status: 'published',
    versionId: other.versionId,
  });
  await assert.rejects(
    service.getAgent(other.id, { model, versionId: updated.versionId }),
    { code: 'AGENT_CONFIG_UNSUPPORTED' },
  );
});

test('admin HTTP and typed RPC enforce session, role, origin and versioned CRUD', async (t) => {
  const origin = 'http://localhost:5173';
  const path = '/api/admin/agents';
  let user: { id: string; role: string } | undefined;
  let requestOrigin: string | undefined = origin;
  const auth = {
    api: { getSession: async () => (user ? { user } : null) },
  } as unknown as Parameters<typeof createApp>[0];
  const service = serviceFor((await new InMemoryStore().getStore('agents'))!);
  const app = createApp(
    auth,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { service, webOrigin: origin },
  );
  const client = createApiClient(() => `${origin}/api/rpc`);
  t.mock.method(globalThis, 'fetch', (request: Request) => {
    const headers = new Headers(request.headers);
    if (requestOrigin) headers.set('Origin', requestOrigin);
    return app.request(new Request(request, { headers }));
  });
  const id = randomUUID(),
    versionId = randomUUID();
  const calls = [
    () => client.agents.list(),
    () => client.agents.catalog(),
    () => client.agents.get({ params: { id } }),
    () => client.agents.create({ body: input }),
    () =>
      client.agents.update({ params: { id }, body: { ...input, versionId } }),
    () => client.agents.remove({ params: { id }, query: { versionId } }),
    () =>
      client.agents.setStatus({
        params: { id },
        body: { status: 'published', versionId },
      }),
  ];
  const http = [
    ['GET', path],
    ['GET', `${path}/catalog`],
    ['GET', `${path}/${id}`],
    ['POST', path, input],
    ['PUT', `${path}/${id}`, { ...input, versionId }],
    ['DELETE', `${path}/${id}?versionId=${versionId}`],
    ['PATCH', `${path}/${id}/status`, { status: 'published', versionId }],
  ] as const;
  for (const role of [undefined, 'user', 'admin-assistant']) {
    user = role ? { id: 'tester', role } : undefined;
    if (!role)
      await assert.rejects(client.agents.available(), { code: 'UNAUTHORIZED' });
    else
      assert.equal(
        (await client.agents.available()).agents[0]?.id,
        fallbackAgentId,
      );
    await assert.rejects(client.agents.defaults(), {
      code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
    });
    await assert.rejects(
      client.agents.saveDefaults({ body: { defaultAgentId: fallbackAgentId } }),
      { code: role ? 'FORBIDDEN' : 'UNAUTHORIZED' },
    );
    for (const call of calls)
      await assert.rejects(call(), {
        code: role ? 'FORBIDDEN' : 'UNAUTHORIZED',
      });
    for (const request of http) {
      const [method, url] = request;
      const response = await app.request(url, {
        method,
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        ...('2' in request ? { body: JSON.stringify(request[2]) } : {}),
      });
      assert.equal(response.status, role ? 403 : 401);
    }
  }
  user = { id: 'admin', role: 'admin' };
  for (const badOrigin of [undefined, 'https://other.example']) {
    requestOrigin = badOrigin;
    for (const call of calls.slice(3))
      await assert.rejects(call(), { code: 'FORBIDDEN' });
  }
  requestOrigin = origin;
  const reserved = { ...input, id: fallbackAgentId };
  await assert.rejects(client.agents.create({ body: reserved }), {
    code: 'VALIDATION_ERROR',
  });
  assert.equal((await client.agents.list()).length, 1);
  await assert.rejects(
    client.agents.create({ body: { ...input, tools: ['unknown' as 'sleep'] } }),
    { code: 'VALIDATION_ERROR' },
  );
  const created = await client.agents.create({ body: input });
  assert.equal((await client.agents.available()).agents.length, 1);
  const published = await client.agents.setStatus({
    params: { id: created.id },
    body: { status: 'published', versionId: created.versionId },
  });
  assert.equal(published.status, 'published');
  assert.equal((await client.agents.available()).agents.length, 2);
  assert.equal((await client.agents.catalog()).skills.length, 1);
  assert.deepEqual(
    await client.agents.get({ params: { id: created.id } }),
    published,
  );
  assert.equal((await client.agents.list()).length, 2);
  const updated = await client.agents.update({
    params: { id: created.id },
    body: {
      ...input,
      model: null,
      instructions: 'HTTP test',
      versionId: created.versionId,
    },
  });
  assert.equal(updated.model, null);
  assert.equal(updated.status, 'published');
  assert.equal(
    (await client.agents.get({ params: { id: created.id } })).model,
    null,
  );
  assert.equal(
    (await client.agents.list()).find((row) => row.id === created.id)?.model,
    null,
  );
  const response = await app.request(`${path}/${created.id}`);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.instructions, 'HTTP test');
  assert.equal(detail.model, null);
  const unpublished = await app.request(`${path}/${created.id}/status`, {
    method: 'PATCH',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'draft', versionId: updated.versionId }),
  });
  assert.equal(unpublished.status, 200);
  assert.equal((await unpublished.json()).status, 'draft');
  assert.equal((await client.agents.available()).agents.length, 1);
  await client.agents.remove({
    params: { id: created.id },
    query: { versionId: updated.versionId },
  });
  await assert.rejects(client.agents.get({ params: { id: created.id } }), {
    code: 'AGENT_NOT_FOUND',
  });
  const emptyModel = await client.agents.create({
    body: { ...input, model: null },
  });
  assert.equal(emptyModel.model, null);
});

test(
  'Postgres native storage persists drafts and every configuration version across store instances',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `agents_test_${randomBytes(8).toString('hex')}`;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const database = new DataSource({
      type: 'postgres',
      url: process.env.TEST_DATABASE_URL,
      schema: schemaName,
      entities: [Setting],
    });
    t.after(async () => {
      if (database.isInitialized) await database.destroy();
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    });
    const storage = new PostgresStore({ id: 'agent-test', pool, schemaName });
    // Only initialize the native agent domain; leave application tables untouched.
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    await database.initialize();
    await database.synchronize();
    const settings = agentSettingsStore(database);
    const store = (await storage.getStore('agents'))!;
    await store.init();
    const service = serviceFor(store, undefined, settings);
    const created = await service.create('admin', input);
    assert.equal((await service.list()).length, 2);
    const updated = await service.update(created.id, {
      ...input,
      name: 'Updated',
      model: null,
      tools: [],
      skillPaths: [],
      versionId: created.versionId,
    });
    const reconnected = new PostgresStore({
      id: 'agent-test-reconnected',
      pool,
      schemaName,
    });
    const reopenedStore = (await reconnected.getStore('agents'))!;
    const reopened = serviceFor(
      reopenedStore,
      undefined,
      agentSettingsStore(database),
    );
    const published = await service.setStatus(created.id, {
      status: 'published',
      versionId: updated.versionId,
    });
    await service.setDefaults({ defaultAgentId: created.id });
    assert.equal((await reopened.getConfig()).id, created.id);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT value FROM "${schemaName}".settings WHERE id = 'agents:defaults'`,
        )
      ).rows[0].value,
      { defaultAgentId: created.id },
    );
    const models = new LanguageModelService(
      database,
      {} as ProviderService,
      service,
    );
    await models.setPreferences('agent-test-user', {
      model: null,
      reasoningEffort: 'auto',
      agentId: created.id,
    });
    assert.equal(
      (
        await new LanguageModelService(
          database,
          {} as ProviderService,
          reopened,
        ).getPreferences('agent-test-user')
      ).agentId,
      created.id,
    );
    await assert.rejects(
      models.setPreferences('agent-test-user', {
        model: null,
        reasoningEffort: 'auto',
        agentId: 'missing',
      }),
      { code: 'AGENT_NOT_FOUND' },
    );
    assert.deepEqual(await reopened.get(created.id), published);
    assert.equal(updated.model, null);
    assert.deepEqual(
      (await reopenedStore.getVersion(updated.versionId))?.model,
      [],
    );
    assert.deepEqual(
      (await reopenedStore.getVersion(created.versionId))?.model,
      {
        provider: 'openai',
        name: 'fixture/model',
        providerId,
      },
    );
    assert.equal(
      (await reopenedStore.getVersion(created.versionId))?.instructions,
      input.instructions,
    );
    assert.equal(await reopenedStore.countVersions(created.id), 2);
    const rows = await pool.query(
      `SELECT status, "activeVersionId" FROM "${schemaName}".mastra_agents WHERE id = $1`,
      [created.id],
    );
    assert.deepEqual(rows.rows, [
      { status: 'published', activeVersionId: updated.versionId },
    ]);
    await reopened.setDefaults({ defaultAgentId: fallbackAgentId });
    await reopened.setStatus(created.id, {
      status: 'draft',
      versionId: updated.versionId,
    });
    await assert.rejects(service.getConfig(created.id), {
      code: 'AGENT_NOT_PUBLISHED',
    });
    await assert.rejects(
      models.setPreferences('agent-test-user', {
        model: null,
        reasoningEffort: 'auto',
        agentId: created.id,
      }),
      { code: 'AGENT_NOT_PUBLISHED' },
    );
    assert.equal((await service.available()).agents.length, 1);
    await reopened.remove(created.id, updated.versionId);
    assert.equal(await reopenedStore.countVersions(created.id), 0);
  },
);
