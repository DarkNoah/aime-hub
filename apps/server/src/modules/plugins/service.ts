import type { DataSource, QueryRunner } from 'typeorm';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import type { BaseAgent } from '@aime/shared/agents';
import { agentInputSchema, agentIdSchema } from '@aime/shared/agents';
import { toolIdSchema, type ToolConfig } from '@aime/shared/tools';
import type { ToolsInput } from '@mastra/core/agent';
import {
  parsePluginConfig,
  pluginConfigDefaults,
  type PluginStatus,
  type PluginConfig,
  type PluginConfigIssue,
  type PluginConfiguration,
  type PluginConfigSaveResult,
} from '@app/plugin-sdk';
import {
  PluginTool,
  type InstalledPlugin,
  type PluginServer,
  type PluginWebServices,
  type PluginNotifications,
} from '@app/plugin-sdk/server';
import type {
  RegisteredTool,
  ToolDefaultConfigs,
  ToolDependencies,
  ToolRegistryOptions,
} from '@app/plugin-sdk/tools';
import { PluginLifecycle } from './lifecycle.js';
import { createPluginRuntime, type PluginRuntimeOptions } from './runtime.js';
import { PluginAccessService } from './access.js';

export class PluginError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
    public readonly issues?: PluginConfigIssue[],
  ) {
    super(code);
  }
}
type Installation = {
  id: string;
  version: string;
  enabled: boolean;
  revision: string;
  config: PluginConfig;
};
type PluginState = PluginStatus & {
  revision: string;
  config: PluginConfig;
  savedConfig: PluginConfig;
  configValid: boolean;
};

/** Code is immutable for the lifetime of a process; activation is read from PostgreSQL. */
export class PluginService {
  readonly access: PluginAccessService;
  private servers = new Map<string, PluginServer>();
  private runtimes = new Map<string, ReturnType<typeof createPluginRuntime>>();
  private lifecycle = new PluginLifecycle(this.servers);
  private queue: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  private disposing?: Promise<void>;
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(
    private readonly database: DataSource,
    readonly definitions: readonly InstalledPlugin[],
    private readonly pollIntervalMs = 2000,
    runtimeOptions: PluginRuntimeOptions = {
      applicationRoot: process.cwd(),
      workspaceRoot: resolve(process.cwd(), 'workspaces'),
    },
    web?: PluginWebServices,
    notifications?: (pluginId: string) => PluginNotifications,
  ) {
    this.access = new PluginAccessService(database);
    const ids = new Set<string>();
    for (const definition of definitions) {
      const { id } = definition.manifest;
      if (ids.has(id)) throw new Error(`Duplicate plugin ID: ${id}`);
      ids.add(id);
      const runtime = createPluginRuntime(definition.manifest, runtimeOptions);
      this.runtimes.set(id, runtime);
      const server = definition.createServer({
        id,
        database,
        web,
        notifications: notifications?.(id),
        runtime,
        assertEnabled: () => this.assertEnabled(id),
      });
      const agents = new Set<string>();
      for (const agent of server.agents ?? []) {
        agentIdSchema.parse(agent.id);
        agentInputSchema.parse(
          Object.fromEntries(
            Object.entries(agent).filter(
              ([key]) => key !== 'id' && key !== 'source',
            ),
          ),
        );
        if (
          agent.source !== 'code' ||
          !agent.id.startsWith(`plugin:${id}:`) ||
          agents.has(agent.id)
        )
          throw new Error(`Invalid plugin Agent ID: ${agent.id}`);
        agents.add(agent.id);
      }
      const tools = new Set<string>();
      for (const tool of server.tools ?? []) {
        if (!(tool instanceof PluginTool))
          throw new Error(`Plugin tools must extend PluginTool: ${id}`);
        toolIdSchema.parse(tool.id);
        if (
          !tool.id.startsWith(`plugin_${id.replaceAll('-', '_')}_`) ||
          tools.has(tool.id)
        )
          throw new Error(`Invalid plugin Tool ID: ${tool.id}`);
        tools.add(tool.id);
      }
      this.servers.set(id, server);
    }
  }

  private async readStates(
    reader: Pick<DataSource, 'query'> = this.database,
  ): Promise<PluginState[]> {
    const [installations, migrations] = await Promise.all([
      reader.query<Installation[]>(
        'SELECT id, version, enabled, config, updated_at::text AS revision FROM plugin_installations',
      ),
      reader.query<{ plugin_id: string; name: string }[]>(
        'SELECT plugin_id, name FROM plugin_migrations',
      ),
    ]);
    const states = this.definitions.map(({ manifest, database }) => {
      const row = installations.find((item) => item.id === manifest.id);
      const ready =
        row?.version === manifest.version &&
        database.migrations.every((Migration) =>
          migrations.some(
            (m) =>
              m.plugin_id === manifest.id &&
              m.name === (new Migration().name ?? Migration.name),
          ),
        );
      const config = parsePluginConfig(
        manifest.configFields,
        row?.config ?? {},
      );
      return {
        ...manifest,
        installedVersion: row?.version ?? null,
        ready,
        enabled: ready && !!row?.enabled && config.success,
        desiredEnabled: !!row?.enabled,
        revision: row?.revision ?? '',
        config: config.success ? config.data : (row?.config ?? {}),
        savedConfig: row?.config ?? {},
        configValid: config.success,
        reason: !ready
          ? '需要运行数据库迁移并发布相同版本'
          : !config.success
            ? '请完善插件参数配置'
            : null,
      };
    });
    // Definitions are topologically ordered by discovery.
    for (const state of states) {
      if (
        state.dependencies.some(
          (id) => !states.find((s) => s.id === id)?.enabled,
        )
      ) {
        state.enabled = false;
        state.reason = '依赖插件未启用';
      }
    }
    return states;
  }

  private runtimeStates(states: PluginState[]): PluginStatus[] {
    const result: PluginStatus[] = [];
    for (const current of states) {
      const { revision } = current;
      // Explicitly project public status: configuration may contain credentials.
      const state: PluginStatus = {
        ...this.definitions.find(
          (definition) => definition.manifest.id === current.id,
        )!.manifest,
        enabled: current.enabled,
        desiredEnabled: current.desiredEnabled,
        ready: current.ready,
        installedVersion: current.installedVersion,
        reason: current.reason,
      };
      if (this.closing) {
        state.enabled = false;
        state.reason = '服务正在关闭';
      } else if (this.lifecycle.reason(state.id)) {
        state.enabled = false;
        state.reason = this.lifecycle.reason(state.id)!;
      } else if (
        state.enabled &&
        !this.lifecycle.isEnabled(state.id, revision)
      ) {
        state.enabled = false;
        state.reason = '插件正在启动或等待状态同步';
      }
      if (
        state.enabled &&
        state.dependencies.some(
          (id) => !result.find((s) => s.id === id)?.enabled,
        )
      ) {
        state.enabled = false;
        state.reason = '依赖插件未就绪';
      }
      result.push(state);
    }
    return result;
  }

  async list(): Promise<PluginStatus[]> {
    return this.runtimeStates(await this.readStates());
  }

  async listForUser(userId?: string): Promise<PluginStatus[]> {
    const [states, allowed] = await Promise.all([
      this.list(),
      this.access.allowedIds(userId),
    ]);
    return states.filter((state) => state.enabled && allowed.has(state.id));
  }

  async assertAccessible(id: string, userId?: string) {
    await this.assertEnabled(id);
    await this.access.assertAllowed(id, userId);
  }

  async workspaceDirectory(
    id: string,
    userId?: string,
  ): Promise<string | undefined> {
    const runtime = this.runtimes.get(id);
    if (!runtime?.paths.pluginWorkspace) return;
    if (!(await this.list()).some((state) => state.id === id && state.enabled))
      return;
    await this.access.assertAllowed(id, userId);
    return runtime.ensureWorkspace();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async withStateLock<T>(work: (runner: QueryRunner) => Promise<T>) {
    if (this.closing) throw new PluginError('PLUGIN_SERVICE_STOPPING', 503);
    const runner = this.database.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      // A session lock spans the callback AND autocommitted state changes: disable
      // is visible to every request before cleanup, while competing toggles wait.
      await runner.query(
        "SELECT pg_advisory_lock(hashtext('host-plugin-state'))",
      );
      locked = true;
      if (this.closing) throw new PluginError('PLUGIN_SERVICE_STOPPING', 503);
      return await work(runner);
    } finally {
      try {
        if (locked)
          await runner.query(
            "SELECT pg_advisory_unlock(hashtext('host-plugin-state'))",
          );
      } finally {
        await runner.release();
      }
    }
  }

  /** Restore resources before accepting requests, then reconcile other instances' changes. */
  start(): Promise<void> {
    if (this.closing)
      return Promise.reject(new PluginError('PLUGIN_SERVICE_STOPPING', 503));
    return (this.starting ??= this.synchronize()
      .then(() => {
        if (
          this.closing ||
          !this.definitions.length ||
          this.pollIntervalMs <= 0
        )
          return;
        this.timer = setInterval(() => {
          if (this.polling || this.closing) return;
          this.polling = true;
          void this.synchronize()
            .catch(() => {
              if (!this.closing)
                console.error('Plugin state synchronization failed');
            })
            .finally(() => {
              this.polling = false;
            });
        }, this.pollIntervalMs);
        this.timer.unref();
      })
      .catch((error) => {
        this.starting = undefined;
        throw error;
      }));
  }

  synchronize(): Promise<void> {
    return this.serialize(() =>
      this.withStateLock(async (runner) => {
        await this.reconcile(await this.readStates(runner));
      }),
    );
  }

  private async reconcile(states: PluginState[]) {
    const wanted = new Set<string>();
    // Restart dependents too when an enabled dependency's generation changes.
    for (const state of states) {
      if (
        state.enabled &&
        this.lifecycle.isEnabled(state.id, state.revision) &&
        state.dependencies.every((id) => wanted.has(id))
      )
        wanted.add(state.id);
    }
    for (const state of [...states].reverse()) {
      if (wanted.has(state.id)) continue;
      try {
        await this.lifecycle.disable(state.id);
      } catch {
        console.error('Plugin cleanup failed', state.id);
      }
    }
    for (const state of states) {
      if (this.closing) break;
      if (
        !state.enabled ||
        state.dependencies.some((id) => {
          const dependency = states.find((s) => s.id === id)!;
          return !this.lifecycle.isEnabled(id, dependency.revision);
        })
      )
        continue;
      try {
        await this.lifecycle.enable(state.id, state.revision, state.config);
      } catch {
        console.error('Plugin activation failed', state.id);
      }
    }
  }

  async assertEnabled(id: string) {
    if (!(await this.list()).some((state) => state.id === id && state.enabled))
      throw new PluginError('PLUGIN_DISABLED', 404);
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginStatus> {
    return this.serialize(() =>
      this.withStateLock(async (runner) => {
        const states = await this.readStates(runner);
        const target = states.find((state) => state.id === id);
        if (!target) throw new PluginError('PLUGIN_NOT_FOUND', 404);
        if (!target.ready) throw new PluginError('PLUGIN_MIGRATION_REQUIRED');
        if (enabled && !target.configValid) {
          const parsed = parsePluginConfig(target.configFields, target.config);
          throw new PluginError(
            'PLUGIN_CONFIG_INVALID',
            400,
            parsed.success ? undefined : parsed.issues,
          );
        }
        if (
          enabled &&
          target.dependencies.some(
            (dependency) => !states.find((s) => s.id === dependency)?.enabled,
          )
        )
          throw new PluginError('PLUGIN_DEPENDENCY_DISABLED');
        if (
          !enabled &&
          states.some(
            (state) => state.desiredEnabled && state.dependencies.includes(id),
          )
        )
          throw new PluginError('PLUGIN_HAS_DEPENDENTS');
        if (enabled) {
          // Do not publish activation until this process and its dependencies are ready.
          await this.reconcile(
            states.map((state) =>
              state.id === id ? { ...state, enabled: true } : state,
            ),
          );
          if (!this.lifecycle.isEnabled(id, target.revision))
            throw new PluginError('PLUGIN_ENABLE_FAILED');
        }
        try {
          if (this.closing)
            throw new PluginError('PLUGIN_SERVICE_STOPPING', 503);
          if (target.desiredEnabled !== enabled) {
            const [updated] = (await runner.query(
              `WITH updated AS (
                UPDATE plugin_installations SET enabled = $2, updated_at = clock_timestamp()
                WHERE id = $1 RETURNING updated_at
              ) SELECT updated_at::text AS revision FROM updated`,
              [id, enabled],
            )) as { revision: string }[];
            if (!updated) throw new PluginError('PLUGIN_NOT_FOUND', 404);
            target.revision = updated.revision;
            target.desiredEnabled = enabled;
          }
          target.enabled = enabled;
          target.reason = null;
          if (enabled) this.lifecycle.setRevision(id, target.revision);
        } catch (error) {
          // Even an ambiguous database write must not leave newly allocated resources live.
          if (enabled) await this.lifecycle.disable(id).catch(() => {});
          throw error;
        }
        if (!enabled) {
          await this.reconcile(states);
          if (this.lifecycle.reason(id))
            throw new PluginError('PLUGIN_DISABLE_FAILED');
        }
        return this.runtimeStates(states).find((state) => state.id === id)!;
      }),
    );
  }

  /** Admin-only API; never merge these values into the shared plugin list. */
  async getConfig(id: string): Promise<PluginConfiguration> {
    const definition = this.definitions.find((item) => item.manifest.id === id);
    if (!definition) throw new PluginError('PLUGIN_NOT_FOUND', 404);
    const [row] = await this.database.query<Installation[]>(
      'SELECT config, updated_at::text AS revision FROM plugin_installations WHERE id = $1',
      [id],
    );
    if (!row) throw new PluginError('PLUGIN_MIGRATION_REQUIRED');
    const fields = definition.manifest.configFields;
    return {
      config: {
        ...pluginConfigDefaults(fields),
        ...Object.fromEntries(
          Object.entries(row.config).filter(([key]) =>
            fields.some((field) => field.key === key),
          ),
        ),
      },
      revision: row.revision,
    };
  }

  async setConfig(
    id: string,
    input: unknown,
    revision: string,
  ): Promise<PluginConfigSaveResult> {
    return this.serialize(() =>
      this.withStateLock(async (runner) => {
        const states = await this.readStates(runner);
        const target = states.find((state) => state.id === id);
        if (!target) throw new PluginError('PLUGIN_NOT_FOUND', 404);
        if (!target.ready) throw new PluginError('PLUGIN_MIGRATION_REQUIRED');
        if (target.revision !== revision)
          throw new PluginError('PLUGIN_CONFIG_CONFLICT');
        const parsed = parsePluginConfig(target.configFields, input);
        if (!parsed.success)
          throw new PluginError('PLUGIN_CONFIG_INVALID', 400, parsed.issues);
        if (!isDeepStrictEqual(target.savedConfig, parsed.data)) {
          await runner.query(
            'UPDATE plugin_installations SET config = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
            [id, JSON.stringify(parsed.data)],
          );
        }
        // Revision changes restart this process and its dependents; old resources keep
        // their original parameter snapshot for cleanup. Other instances follow by polling.
        const updated = await this.readStates(runner);
        await this.reconcile(updated);
        const state = updated.find((state) => state.id === id)!;
        const plugin = this.runtimeStates(updated).find(
          (state) => state.id === id,
        )!;
        return {
          plugin,
          configuration: { config: state.config, revision: state.revision },
          applied:
            !this.lifecycle.reason(id) &&
            (!state.desiredEnabled || plugin.enabled),
        };
      }),
    );
  }

  api(id: string) {
    return this.servers.get(id)?.api;
  }

  async agents(userId?: string): Promise<BaseAgent[]> {
    const states = userId ? await this.listForUser(userId) : await this.list();
    return states
      .filter((s) => s.enabled)
      .flatMap((s) => structuredClone(this.servers.get(s.id)?.agents ?? []));
  }

  ownsTool(id: string) {
    return [...this.servers.values()].some((s) =>
      s.tools?.some((tool) => tool.id === id),
    );
  }

  async toolConfigs(defaults: ToolDefaultConfigs = {}): Promise<ToolConfig[]> {
    const states = await this.list();
    const rows = await this.database.query<
      { id: string; value: { enabled?: boolean } }[]
    >(
      "SELECT id, value FROM settings WHERE id LIKE 'tool:plugin_%' AND deleted_at IS NULL",
    );
    return states.flatMap((state) =>
      (this.servers.get(state.id)?.tools ?? []).map((tool) =>
        tool.parseConfig({
          enabled:
            state.enabled &&
            (rows.find((row) => row.id === `tool:${tool.id}`)?.value.enabled ??
              defaults[tool.id]?.enabled ??
              true),
        }),
      ),
    );
  }

  async tools(
    defaults: ToolDefaultConfigs = {},
    dependencies: ToolDependencies = {},
    options: ToolRegistryOptions = {},
  ): Promise<ToolsInput> {
    const caller = dependencies.context?.requestContext?.get('userId');
    const allowed =
      typeof caller === 'string'
        ? await this.access.allowedIds(caller)
        : undefined;
    const configs = new Map(
      (await this.toolConfigs(defaults)).map((tool) => [tool.id, tool.config]),
    );
    const entries = await Promise.all(
      [...this.servers.entries()].flatMap(([pluginId, server]) =>
        (server.tools ?? []).map(async (definition) => {
          if (allowed && !allowed.has(pluginId)) return [];
          if (!configs.get(definition.id)?.enabled) return [];
          const tools = await definition.getTools(
            defaults,
            { ...dependencies, loadConfig: async (id) => configs.get(id) },
            options,
          );
          return tools.map((tool) => {
            const execute = 'execute' in tool && tool.execute;
            if (!execute)
              throw new Error(`Plugin Tool requires execute: ${tool.id}`);
            // Guard constructed instances, including handles retained after plugin disable.
            const descriptors = Object.getOwnPropertyDescriptors(tool);
            descriptors.execute = {
              configurable: true,
              enumerable: true,
              value: async (...args: Parameters<typeof execute>) => {
                const userId = args[1]?.requestContext?.get('userId') ?? caller;
                await this.assertAccessible(
                  pluginId,
                  typeof userId === 'string' ? userId : undefined,
                );
                return Reflect.apply(execute, tool, args);
              },
            };
            const guarded = Object.create(
              Object.getPrototypeOf(tool),
              descriptors,
            ) as RegisteredTool;
            return [guarded.id, guarded] as const;
          });
        }),
      ),
    );
    return Object.fromEntries(entries.flat());
  }

  beginShutdown() {
    this.closing = true;
    clearInterval(this.timer);
  }

  dispose(): Promise<void> {
    this.beginShutdown();
    return (this.disposing ??= this.serialize(() => this.lifecycle.dispose()));
  }
}
