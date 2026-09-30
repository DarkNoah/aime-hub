import { Mastra } from '@mastra/core/mastra';
import type { Pool } from 'pg';
import { createChatStorage } from './storage.js';

// One runtime per server. Injection also lets integration tests use isolated schemas.
export function createMastraRuntime(pool: Pool, schemaName = 'mastra') {
  const { storage, memory } = createChatStorage(pool, schemaName);
  const mastra = new Mastra({
    // Register system-defined agents from ./agents here. Per-thread agents stay in modules/threads.
    agents: {},
    workflows: {},
    storage,
  });
  return { mastra, storage, memory };
}
