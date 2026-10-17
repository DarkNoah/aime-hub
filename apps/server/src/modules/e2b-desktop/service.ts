import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import {
  desktopSandboxIdSchema,
  type DesktopSandbox,
  type DesktopSandboxCreate,
} from '@aime/shared/e2b-desktop';
import type { SystemSettingsService } from '../system-settings/service.js';

type Config = Awaited<ReturnType<SystemSettingsService['getE2BDesktopConfig']>>;
const managedBy = 'desktop-admin';
const upstreamSandboxSchema = z.object({
  sandboxID: desktopSandboxIdSchema,
  templateID: z.string(),
  state: z.enum(['running', 'paused']),
  startedAt: z.string(),
  endAt: z.string(),
  cpuCount: z.number(),
  memoryMB: z.number(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
type UpstreamSandbox = z.infer<typeof upstreamSandboxSchema>;

function summary(value: UpstreamSandbox): DesktopSandbox {
  return {
    id: value.sandboxID,
    name: value.metadata?.name ?? '',
    template: value.templateID,
    state: value.state,
    startedAt: value.startedAt,
    endAt: value.endAt,
    cpuCount: value.cpuCount,
    memoryMB: value.memoryMB,
  };
}

export class E2BDesktopService {
  constructor(
    private readonly settings: SystemSettingsService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(
    config: Config,
    path: string,
    method = 'GET',
    body?: unknown,
  ) {
    try {
      const response = await this.fetcher(
        `${config.apiUrl.replace(/\/+$/, '')}/${path}`,
        {
          method,
          headers: {
            'X-API-Key': config.apiKey,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        const code =
          response.status === 401 || response.status === 403
            ? 'E2B_AUTH_FAILED'
            : response.status === 404
              ? 'E2B_NOT_FOUND'
              : response.status === 429
                ? 'E2B_RATE_LIMITED'
                : 'E2B_REQUEST_FAILED';
        throw new ORPCError(code, { status: 502 });
      }
      return response;
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      // Do not expose upstream bodies, credentials or URLs through logs/errors.
      throw new ORPCError('E2B_UNAVAILABLE', { status: 502 });
    }
  }

  private async json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ORPCError('E2B_INVALID_RESPONSE', { status: 502 });
    }
  }

  async test() {
    const config = await this.settings.getE2BDesktopConfig(false);
    const response = await this.request(config, 'v2/sandboxes?limit=1');
    await this.json(response, z.array(upstreamSandboxSchema));
    return { ok: true as const };
  }

  async list(nextToken?: string) {
    const config = await this.settings.getE2BDesktopConfig();
    const query = new URLSearchParams({
      limit: '50',
      metadata: new URLSearchParams({ managedBy }).toString(),
    });
    if (nextToken) query.set('nextToken', nextToken);
    const response = await this.request(config, `v2/sandboxes?${query}`);
    const items = await this.json(response, z.array(upstreamSandboxSchema));
    return {
      items: items
        .filter((item) => item.metadata?.managedBy === managedBy)
        .map(summary),
      nextToken: response.headers.get('X-Next-Token') || null,
    };
  }

  async create(input: DesktopSandboxCreate) {
    const config = await this.settings.getE2BDesktopConfig();
    const response = await this.request(config, 'v2/sandboxes', 'POST', {
      templateID: input.template ?? config.template,
      timeout: input.timeoutSeconds ?? config.timeoutSeconds,
      metadata: { managedBy, name: input.name },
    });
    // Creation already succeeded. Return its ID without a fallible follow-up request
    // that could make the user retry and accidentally create a second instance.
    const created = await this.json(
      response,
      z.object({ sandboxID: desktopSandboxIdSchema }),
    );
    return { id: created.sandboxID };
  }

  private async owned(config: Config, id: string) {
    const response = await this.request(
      config,
      `sandboxes/${encodeURIComponent(id)}`,
    );
    const value = await this.json(response, upstreamSandboxSchema);
    if (value.metadata?.managedBy !== managedBy)
      throw new ORPCError('E2B_NOT_MANAGED', { status: 403 });
    return value;
  }

  async get(id: string) {
    const config = await this.settings.getE2BDesktopConfig();
    return summary(await this.owned(config, id));
  }

  async update(id: string, timeoutSeconds: number) {
    const config = await this.settings.getE2BDesktopConfig();
    await this.owned(config, id);
    const response = await this.request(
      config,
      `sandboxes/${encodeURIComponent(id)}/timeout`,
      'POST',
      { timeout: timeoutSeconds },
    );
    await response.body?.cancel();
    return { ok: true as const };
  }

  async delete(id: string) {
    const config = await this.settings.getE2BDesktopConfig();
    await this.owned(config, id);
    const response = await this.request(
      config,
      `sandboxes/${encodeURIComponent(id)}`,
      'DELETE',
    );
    await response.body?.cancel();
    return { ok: true as const };
  }
}
