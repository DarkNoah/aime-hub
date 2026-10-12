import { Mastra } from '@mastra/core/mastra';
import type { Pool } from 'pg';
import { createChatStorage } from './storage.js';
import type { ScheduleHooks } from '@mastra/core/schedules';

// One runtime per server. Injection also lets integration tests use isolated schemas.
export function createMastraRuntime(
  pool: Pool,
  schemaName = 'mastra',
  schedules?: ScheduleHooks<Mastra>,
) {
  const { storage, memory } = createChatStorage(pool, schemaName);
  const mastra = new Mastra({
    // Code and stored configurations are resolved by AgentService; runtime instances belong to each thread.
    agents: {},
    workflows: {},
    storage,
    schedules,
    backgroundTasks: {
      enabled: true,
      globalConcurrency: 10,
      perAgentConcurrency: 5,
      backpressure: 'queue',
      // defaultTimeoutMs: 300_000,
    },
  });
  return { mastra, storage, memory };
}
