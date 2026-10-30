import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentsStorage } from '@mastra/core/storage';
import type { AgentInput } from '@aime/shared/agents';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createChatRunner } from '../threads/runner.js';
import type { LanguageModelService } from '../models/language-model.js';
import type { ChatSettings } from '@aime/shared/threads';
import { AgentService } from './service.js';
import { botAgent } from '../../mastra/agents/bot-agent.js';
import { assistantAgent } from '../../mastra/agents/code.js';
import {
  agentIds,
  fallbackAgentId,
  getAgent,
  getCodeAgent,
} from '../../mastra/agents/index.js';
import { buildAgent } from '../../mastra/agents/factory.js';

function service() {
  return new AgentService(
    {
      list: async () => ({ agents: [{ id: botAgent.id }] }),
      getById: async () =>
        assert.fail('Hidden code IDs must not fall back to storage'),
    } as unknown as AgentsStorage,
    { list: async () => ({ skills: [] }) } as unknown as ConstructorParameters<
      typeof AgentService
    >[1],
    { list: async () => [] },
    { listAvailableModels: async () => ({ providers: [] }) },
    {
      read: async () => ({ defaultAgentId: botAgent.id }),
      write: async () =>
        assert.fail('Hidden agents cannot become chat defaults'),
    },
  );
}

test('hidden leader is reserved but absent from every public agent catalog and lookup', async () => {
  const agents = service();
  assert.equal(getCodeAgent('bot')?.id, botAgent.id);
  assert.equal(getCodeAgent(botAgent.id)?.hidden, true);
  assert.equal(agentIds.includes('bot'), false);
  assert.equal(
    (await agents.list()).some((agent) => agent.id === botAgent.id),
    false,
  );
  assert.equal(
    (await agents.catalog()).agents.some((agent) => agent.id === botAgent.id),
    false,
  );
  assert.equal(
    (await agents.available()).agents.some((agent) => agent.id === botAgent.id),
    false,
  );
  assert.deepEqual(await agents.getDefaults(), {
    defaultAgentId: fallbackAgentId,
  });
  for (const id of ['bot', botAgent.id]) {
    assert.equal(getAgent(id), undefined);
    await assert.rejects(agents.get(id), { code: 'AGENT_NOT_FOUND' });
    await assert.rejects(agents.getConfig(id), { code: 'AGENT_NOT_FOUND' });
    await assert.rejects(agents.getAgent(id, { model: 'test/model' }), {
      code: 'AGENT_NOT_FOUND',
    });
    await assert.rejects(agents.setDefaults({ defaultAgentId: id }), {
      code: 'AGENT_NOT_FOUND',
    });
  }
});

test('hidden leader cannot be selected as a configured native subagent', async () => {
  const input: AgentInput = {
    name: 'Worker',
    instructions: 'Help the user.',
    model: null,
    skillPaths: [],
    agents: { leader: botAgent.id },
  };
  await assert.rejects(service().create('alice', input), {
    code: 'AGENT_SUBAGENT_UNAVAILABLE',
  });
  assert.throws(
    () =>
      buildAgent(
        { ...assistantAgent, agents: { leader: botAgent.id } },
        { model: 'test/model' },
      ),
    /Unknown subagent/,
  );
});

test('only a trusted room leader role can resolve the hidden agent in the runner', async (t) => {
  const mastra = new Mastra({ storage: new InMemoryStore(), logger: false });
  t.after(() => mastra.shutdown());
  const runner = createChatRunner(
    mastra,
    {} as LanguageModelService,
    '/tmp/hidden-agent-registry',
  );
  const settings: ChatSettings = { model: null, reasoningEffort: 'auto' };
  for (const id of ['bot', botAgent.id]) {
    await assert.rejects(
      runner.resolveSettings!({ ...settings, agentId: id }),
      { code: 'AGENT_NOT_FOUND' },
    );
    await assert.rejects(
      runner.resolveSettings!(
        { ...settings, agentId: id },
        'alice',
        undefined,
        'worker',
      ),
      { code: 'AGENT_NOT_FOUND' },
    );
  }
  // Existing room records may still carry an old generic/default Agent reference.
  assert.equal(
    (
      await runner.resolveSettings!(
        { ...settings, agentId: 'missing' },
        'alice',
        undefined,
        'bot',
      )
    ).agentId,
    botAgent.id,
  );
  assert.equal(
    await runner.sessionKey!(settings, 'alice', undefined, 'bot'),
    `${botAgent.id}:code`,
  );
});
