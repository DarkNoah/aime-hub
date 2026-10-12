import type { DataSource } from 'typeorm';
import { Setting } from '@aime/db';
import {
  defaultSystemSettings,
  systemSettingsSchema,
  type SystemSettings,
} from '@aime/shared/system-settings';

const id = 'system:settings';

export class SystemSettingsService {
  constructor(private readonly database: DataSource) {}

  async get(): Promise<SystemSettings> {
    const row = await this.database.manager.findOneBy(Setting, { id });
    return row
      ? systemSettingsSchema.parse(row.value)
      : { ...defaultSystemSettings };
  }

  async update(input: SystemSettings): Promise<SystemSettings> {
    const value = systemSettingsSchema.parse(input);
    await this.database.manager.upsert(Setting, { id, value }, ['id']);
    return value;
  }
}
