import { PostgresStore } from '@mastra/pg';
import { Memory } from '@mastra/memory';
import type { Pool } from 'pg';

export function createChatStorage(pool: Pool, schemaName = 'mastra') {
  const storage = new PostgresStore({ id: 'aime-chat', pool, schemaName });
  const memory = new Memory({
    storage,
    options: { lastMessages: 40, semanticRecall: false, generateTitle: false },
  });
  return { storage, memory };
}
