import type { DataSource } from 'typeorm';
import { Setting } from '@aime/db';
import {
  defaultSystemSettings,
  systemSettingsSchema,
  systemSettingsUpdateSchema,
  type SystemSettings,
  type SystemSettingsUpdate,
} from '@aime/shared/system-settings';

const id = 'system:settings';
const storedSettingsSchema = systemSettingsSchema.extend({
  requestLoggingEnabled:
    systemSettingsSchema.shape.requestLoggingEnabled.default(
      defaultSystemSettings.requestLoggingEnabled,
    ),
});

export class SystemSettingsService {
  private pendingUpdate: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly database: DataSource,
    private readonly onUpdate?: (settings: SystemSettings) => void,
  ) {}

  async get(): Promise<SystemSettings> {
    const row = await this.database.manager.findOneBy(Setting, { id });
    return row
      ? storedSettingsSchema.parse(row.value)
      : { ...defaultSystemSettings };
  }

  async update(input: SystemSettingsUpdate): Promise<SystemSettings> {
    const patch = systemSettingsUpdateSchema.parse(input);
    // Serialize updates so independent switches cannot overwrite each other.
    const pending = this.pendingUpdate.then(async () => {
      const value = { ...(await this.get()), ...patch };
      await this.database.manager.upsert(Setting, { id, value }, ['id']);
      this.onUpdate?.(value);
      return value;
    });
    this.pendingUpdate = pending.catch(() => {});
    return pending;
  }
}
