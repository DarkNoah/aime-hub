import type { DataSource } from 'typeorm';
import { Setting } from '@aime/db';
import { agentDefaultsSchema, type AgentDefaults } from '@aime/shared/agents';

export interface AgentSettingsStore {
  read(): Promise<AgentDefaults | null>;
  write(value: AgentDefaults): Promise<void>;
}

export function agentSettingsStore(database: DataSource): AgentSettingsStore {
  const id = 'agents:defaults';
  return {
    async read() {
      const row = await database.manager.findOneBy(Setting, { id });
      return row ? agentDefaultsSchema.parse(row.value) : null;
    },
    async write(value) {
      await database.manager.upsert(Setting, { id, value }, ['id']);
    },
  };
}
