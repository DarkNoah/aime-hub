import { PostgresStore } from '@mastra/pg';
import { ChatMemory, type ChatMemoryConfig } from './memory.js';
import type { Pool } from 'pg';

export function createChatStorage(
  pool: Pool,
  schemaName = 'mastra',
  config: ChatMemoryConfig = {},
) {
  const storage = new PostgresStore({ id: 'aime-chat', pool, schemaName });
  const memory = new ChatMemory({
    ...config,
    storage,
    options: {
      lastMessages: 40,
      semanticRecall: false,
      ...config.options,
      generateTitle: false,
    },
  });
  return { storage, memory };
}
