import type { DataSource } from 'typeorm';
import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import { Setting } from '@aime/db';
import {
  defaultSystemSettings,
  systemSettingsSchema,
  systemSettingsUpdateSchema,
  type SystemSettings,
  type SystemSettingsUpdate,
} from '@aime/shared/system-settings';

const id = 'system:settings';
const storedSettingsSchema = systemSettingsSchema
  .omit({
    e2bDesktopHasApiKey: true,
    e2bDesktopManaged: true,
  })
  .extend({
    requestLoggingEnabled:
      systemSettingsSchema.shape.requestLoggingEnabled.default(
        defaultSystemSettings.requestLoggingEnabled,
      ),
    e2bDesktopEnabled:
      systemSettingsSchema.shape.e2bDesktopEnabled.default(false),
    e2bDesktopApiUrl: systemSettingsSchema.shape.e2bDesktopApiUrl.default(''),
    e2bDesktopTemplate:
      systemSettingsSchema.shape.e2bDesktopTemplate.default('desktop'),
    e2bDesktopTimeoutSeconds:
      systemSettingsSchema.shape.e2bDesktopTimeoutSeconds.default(300),
    e2bDesktopApiKey: z.string().nullable().default(null),
  });

function publicSettings(
  value: z.infer<typeof storedSettingsSchema>,
  managed: boolean,
): SystemSettings {
  const { e2bDesktopApiKey, ...settings } = value;
  return {
    ...settings,
    e2bDesktopHasApiKey: Boolean(e2bDesktopApiKey),
    e2bDesktopManaged: managed,
  };
}

export type E2BDesktopDeployment = {
  apiUrl: string;
  apiKey: string;
  template: string;
  timeoutSeconds: number;
};

export class SystemSettingsService {
  private pendingUpdate: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly database: DataSource,
    private readonly onUpdate?: (settings: SystemSettings) => void,
    private readonly desktopDeployment?: E2BDesktopDeployment,
  ) {}

  private effective(value: z.infer<typeof storedSettingsSchema>) {
    if (!this.desktopDeployment) return value;
    return {
      ...value,
      e2bDesktopEnabled: true,
      e2bDesktopApiUrl: this.desktopDeployment.apiUrl,
      e2bDesktopApiKey: this.desktopDeployment.apiKey,
      e2bDesktopTemplate: this.desktopDeployment.template,
      e2bDesktopTimeoutSeconds: this.desktopDeployment.timeoutSeconds,
    };
  }

  private async read() {
    const row = await this.database.manager.findOneBy(Setting, { id });
    return storedSettingsSchema.parse(
      row?.value ?? {
        registrationEnabled: defaultSystemSettings.registrationEnabled,
      },
    );
  }

  async get(): Promise<SystemSettings> {
    return publicSettings(
      this.effective(await this.read()),
      Boolean(this.desktopDeployment),
    );
  }

  // Server-only credentials; never return this object from an RPC handler.
  async getE2BDesktopConfig(requireEnabled = true) {
    const settings = this.effective(await this.read());
    if (requireEnabled && !settings.e2bDesktopEnabled)
      throw new ORPCError('E2B_DISABLED', { status: 409 });
    if (
      !settings.e2bDesktopApiUrl ||
      !settings.e2bDesktopApiKey ||
      !settings.e2bDesktopTemplate
    )
      throw new ORPCError('E2B_NOT_CONFIGURED', { status: 409 });
    return {
      apiUrl: settings.e2bDesktopApiUrl,
      apiKey: settings.e2bDesktopApiKey,
      template: settings.e2bDesktopTemplate,
      timeoutSeconds: settings.e2bDesktopTimeoutSeconds,
    };
  }

  async update(input: SystemSettingsUpdate): Promise<SystemSettings> {
    const { e2bDesktopApiKey, ...patch } =
      systemSettingsUpdateSchema.parse(input);
    if (
      this.desktopDeployment &&
      (e2bDesktopApiKey !== undefined ||
        Object.keys(patch).some((key) => key.startsWith('e2bDesktop')))
    )
      throw new ORPCError('E2B_MANAGED_CONFIG', { status: 409 });
    // Serialize updates so independent switches cannot overwrite each other.
    const pending = this.pendingUpdate.then(async () => {
      const value = { ...(await this.read()), ...patch };
      // Omitted or blank API keys preserve the stored value; null explicitly clears it.
      if (e2bDesktopApiKey !== undefined && e2bDesktopApiKey !== '')
        value.e2bDesktopApiKey = e2bDesktopApiKey;
      if (
        value.e2bDesktopEnabled &&
        (!value.e2bDesktopApiUrl ||
          !value.e2bDesktopApiKey ||
          !value.e2bDesktopTemplate)
      )
        throw new ORPCError('VALIDATION_ERROR', { status: 400 });
      await this.database.manager.upsert(Setting, { id, value }, ['id']);
      const result = publicSettings(
        this.effective(value),
        Boolean(this.desktopDeployment),
      );
      this.onUpdate?.(result);
      return result;
    });
    this.pendingUpdate = pending.catch(() => {});
    return pending;
  }
}
